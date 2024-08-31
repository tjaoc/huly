//
// Copyright © 2022 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import contact, { Channel, ChannelProvider, Contact, Employee, formatName, PersonAccount } from '@hcengineering/contact'
import {
  Account,
  Class,
  concatLink,
  Doc,
  DocumentQuery,
  FindOptions,
  FindResult,
  Hierarchy,
  Ref,
  toWorkspaceString,
  Tx,
  TxCreateDoc,
  TxProcessor
} from '@hcengineering/core'
import { TriggerControl } from '@hcengineering/server-core'
import telegram, { TelegramMessage, TelegramNotificationRecord } from '@hcengineering/telegram'
import { BaseNotificationType, InboxNotification, NotificationType } from '@hcengineering/notification'
import setting, { Integration } from '@hcengineering/setting'
import { NotificationProviderFunc, ReceiverInfo, SenderInfo } from '@hcengineering/server-notification'
import { getMetadata, getResource, translate } from '@hcengineering/platform'
import serverTelegram from '@hcengineering/server-telegram'
import {
  getTranslatedNotificationContent,
  getTextPresenter,
  getNotificationLink
} from '@hcengineering/server-notification-resources'
import { generateToken } from '@hcengineering/server-token'
import chunter, { ChatMessage } from '@hcengineering/chunter'
import { markupToHTML } from '@hcengineering/text'
import activity, { ActivityMessage, DocUpdateMessage } from '@hcengineering/activity'

/**
 * @public
 */
export async function FindMessages (
  doc: Doc,
  hiearachy: Hierarchy,
  findAll: <T extends Doc>(
    clazz: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ) => Promise<FindResult<T>>
): Promise<Doc[]> {
  const channel = doc as Channel
  if (channel.provider !== contact.channelProvider.Telegram) {
    return []
  }
  const messages = await findAll(telegram.class.Message, { attachedTo: channel._id })
  const newMessages = await findAll(telegram.class.NewMessage, { attachedTo: channel._id })
  return [...messages, ...newMessages]
}

/**
 * @public
 */
export async function OnMessageCreate (tx: Tx, control: TriggerControl): Promise<Tx[]> {
  const res: Tx[] = []

  const message = TxProcessor.createDoc2Doc<TelegramMessage>(tx as TxCreateDoc<TelegramMessage>)
  const channel = (await control.findAll(contact.class.Channel, { _id: message.attachedTo }, { limit: 1 }))[0]
  if (channel !== undefined) {
    if (channel.lastMessage === undefined || channel.lastMessage < message.sendOn) {
      const tx = control.txFactory.createTxUpdateDoc(channel._class, channel.space, channel._id, {
        lastMessage: message.sendOn
      })
      res.push(tx)
    }
  }

  return res
}

/**
 * @public
 */
export function IsIncomingMessageTypeMatch (
  tx: Tx,
  doc: Doc,
  user: Ref<Account>[],
  type: NotificationType,
  control: TriggerControl
): boolean {
  const message = TxProcessor.createDoc2Doc(TxProcessor.extractTx(tx) as TxCreateDoc<TelegramMessage>)
  return message.incoming && message.sendOn > (doc.createdOn ?? doc.modifiedOn)
}

export async function GetCurrentEmployeeTG (
  control: TriggerControl,
  context: Record<string, Doc>
): Promise<string | undefined> {
  const account = await control.modelDb.findOne(contact.class.PersonAccount, {
    _id: control.txFactory.account as Ref<PersonAccount>
  })
  if (account === undefined) return
  const employee = (await control.findAll(contact.mixin.Employee, { _id: account.person as Ref<Employee> }))[0]
  if (employee !== undefined) {
    return await getContactChannel(control, employee, contact.channelProvider.Telegram)
  }
}

export async function GetIntegrationOwnerTG (
  control: TriggerControl,
  context: Record<string, Doc>
): Promise<string | undefined> {
  const value = context[setting.class.Integration] as Integration
  if (value === undefined) return
  const account = await control.modelDb.findOne(contact.class.PersonAccount, {
    _id: value.modifiedBy as Ref<PersonAccount>
  })
  if (account === undefined) return
  const employee = (await control.findAll(contact.mixin.Employee, { _id: account.person as Ref<Employee> }))[0]
  if (employee !== undefined) {
    return await getContactChannel(control, employee, contact.channelProvider.Telegram)
  }
}

async function getContactChannel (
  control: TriggerControl,
  value: Contact,
  provider: Ref<ChannelProvider>
): Promise<string | undefined> {
  if (value === undefined) return
  const res = (
    await control.findAll(contact.class.Channel, {
      attachedTo: value._id,
      provider
    })
  )[0]
  return res?.value ?? ''
}

async function activityMessageToHtml (control: TriggerControl, message: ActivityMessage): Promise<string | undefined> {
  const { hierarchy } = control
  if (hierarchy.isDerived(message._class, chunter.class.ChatMessage)) {
    const chatMessage = message as ChatMessage
    return markupToHTML(chatMessage.message)
  } else {
    const resource = getTextPresenter(message._class, control.hierarchy)

    if (resource !== undefined) {
      const fn = await getResource(resource.presenter)
      const textData = await fn(message, control)
      if (textData !== undefined && textData !== '') {
        return markupToHTML(textData)
      }
    }
  }

  return undefined
}

function isReactionMessage (message?: ActivityMessage): boolean {
  return (
    message !== undefined &&
    message._class === activity.class.DocUpdateMessage &&
    (message as DocUpdateMessage).objectClass === activity.class.Reaction
  )
}

async function getTranslatedData (
  data: InboxNotification,
  doc: Doc,
  control: TriggerControl,
  message?: ActivityMessage
): Promise<{
    title: string
    quote: string | undefined
    body: string
    link: string
  }> {
  const { hierarchy } = control

  let { title, body } = await getTranslatedNotificationContent(data, data._class, control)
  let quote: string | undefined

  if (data.data !== undefined) {
    body = markupToHTML(data.data)
  } else if (message !== undefined) {
    const html = await activityMessageToHtml(control, message)
    if (html !== undefined) {
      body = html
    }
  }

  if (hierarchy.isDerived(doc._class, activity.class.ActivityMessage)) {
    const html = await activityMessageToHtml(control, doc as ActivityMessage)
    if (html !== undefined) {
      quote = html
    }
  }

  if (isReactionMessage(message)) {
    title = await translate(activity.string.Reacted, {})
  }

  return {
    title,
    quote,
    body,
    link: await getNotificationLink(control, doc, message?._id)
  }
}

const SendTelegramNotifications: NotificationProviderFunc = async (
  control: TriggerControl,
  types: BaseNotificationType[],
  doc: Doc,
  data: InboxNotification,
  receiver: ReceiverInfo,
  sender: SenderInfo,
  message?: ActivityMessage
): Promise<Tx[]> => {
  if (types.length === 0) {
    return []
  }

  const botUrl = getMetadata(serverTelegram.metadata.BotUrl)

  if (botUrl === undefined || botUrl === '') {
    control.ctx.error('Please provide telegram bot service url to enable telegram notifications.')
    return []
  }

  if (!receiver.person.active) {
    return []
  }

  try {
    const { title, body, quote, link } = await getTranslatedData(data, doc, control, message)
    const record: TelegramNotificationRecord = {
      notificationId: data._id,
      account: receiver._id,
      workspace: toWorkspaceString(control.workspace),
      sender: data.intlParams?.senderName?.toString() ?? formatName(sender.person?.name ?? 'System'),
      title,
      quote,
      body,
      link
    }

    await fetch(concatLink(botUrl, '/notify'), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + generateToken(receiver.account.email, control.workspace),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([record])
    })
  } catch (err) {
    control.ctx.error('Could not send telegram notification', {
      err,
      notificationId: data._id,
      receiver: receiver.account.email
    })
  }

  return []
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  trigger: {
    OnMessageCreate
  },
  function: {
    IsIncomingMessageTypeMatch,
    FindMessages,
    GetCurrentEmployeeTG,
    GetIntegrationOwnerTG,
    SendTelegramNotifications
  }
})
