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

import contact, { Contact, Employee, Person, PersonAccount, formatName, getName } from '@hcengineering/contact'
import core, {
  Doc,
  Ref,
  SortingOrder,
  toIdMap,
  Tx,
  TxCreateDoc,
  TxFactory,
  TxMixin,
  TxProcessor,
  TxRemoveDoc,
  TxUpdateDoc
} from '@hcengineering/core'
import hr, {
  Department,
  DepartmentMember,
  fromTzDate,
  PublicHoliday,
  Request,
  Staff,
  tzDateEqual
} from '@hcengineering/hr'
import notification, { NotificationType } from '@hcengineering/notification'
import { translate } from '@hcengineering/platform'
import { TriggerControl } from '@hcengineering/server-core'
import { getEmployee, getPersonAccountById } from '@hcengineering/server-notification'
import { getContent, isAllowed, sendEmailNotification } from '@hcengineering/server-notification-resources'

async function getOldDepartment (
  currentTx: TxMixin<Employee, Staff> | TxUpdateDoc<Employee>,
  control: TriggerControl
): Promise<Ref<Department> | undefined> {
  const txes = await control.findAll<TxMixin<Employee, Staff>>(
    core.class.TxMixin,
    {
      objectId: currentTx.objectId
    },
    { sort: { modifiedOn: SortingOrder.Ascending } }
  )
  let lastDepartment: Ref<Department> | undefined
  for (const tx of txes) {
    if (tx._id === currentTx._id) continue
    if (tx.attributes?.department !== undefined) {
      lastDepartment = tx.attributes.department
    }
  }
  return lastDepartment
}

async function buildHierarchy (_id: Ref<Department>, control: TriggerControl): Promise<Department[]> {
  const res: Department[] = []
  const ancestors = new Map<Ref<Department>, Ref<Department>>()
  const departments = await control.findAll(hr.class.Department, {})
  for (const department of departments) {
    if (department._id === hr.ids.Head || department.parent === undefined) continue
    ancestors.set(department._id, department.parent)
  }
  const departmentsMap = toIdMap(departments)
  while (true) {
    const department = departmentsMap.get(_id)
    if (department === undefined) return res
    res.push(department)
    const next = ancestors.get(department._id)
    if (next === undefined) return res
    _id = next
  }
}

function exlude (first: Ref<Department>[], second: Ref<Department>[]): Ref<Department>[] {
  const set = new Set(first)
  const res: Ref<Department>[] = []
  for (const department of second) {
    if (!set.has(department)) {
      res.push(department)
    }
  }
  return res
}

function getTxes (
  factory: TxFactory,
  account: Ref<DepartmentMember>,
  added: Ref<Department>[],
  removed?: Ref<Department>[]
): Tx[] {
  const pushTxes = added.map((dep) =>
    factory.createTxUpdateDoc(hr.class.Department, core.space.Workspace, dep, {
      $push: { members: account }
    })
  )
  if (removed === undefined) return pushTxes
  const pullTxes = removed.map((dep) =>
    factory.createTxUpdateDoc(hr.class.Department, core.space.Workspace, dep, {
      $pull: { members: account }
    })
  )
  return [...pullTxes, ...pushTxes]
}

/**
 * @public
 */
export async function OnDepartmentStaff (tx: Tx, control: TriggerControl): Promise<Tx[]> {
  const ctx = TxProcessor.extractTx(tx) as TxMixin<Employee, Staff>

  const targetAccount = (
    await control.modelDb.findAll(contact.class.PersonAccount, {
      person: ctx.objectId
    })
  )[0]
  if (targetAccount === undefined) return []

  if (ctx.attributes.department !== undefined) {
    const lastDepartment = await getOldDepartment(ctx, control)

    const departmentId = ctx.attributes.department
    if (departmentId === null) {
      if (lastDepartment !== undefined) {
        const removed = await buildHierarchy(lastDepartment, control)
        return getTxes(
          control.txFactory,
          targetAccount._id,
          [],
          removed.map((p) => p._id)
        )
      }
    }
    const push = (await buildHierarchy(departmentId, control)).map((p) => p._id)

    if (lastDepartment === undefined) {
      return getTxes(control.txFactory, targetAccount._id, push)
    }

    let removed = (await buildHierarchy(lastDepartment, control)).map((p) => p._id)
    const added = exlude(removed, push)
    removed = exlude(push, removed)
    return getTxes(control.txFactory, targetAccount._id, added, removed)
  }

  return []
}

/**
 * @public
 */
export async function OnDepartmentRemove (tx: Tx, control: TriggerControl): Promise<Tx[]> {
  const ctx = TxProcessor.extractTx(tx) as TxRemoveDoc<Department>

  const department = control.removedMap.get(ctx.objectId) as Department
  if (department === undefined) return []
  const res: Tx[] = []
  const nested = await control.findAll(hr.class.Department, { parent: department._id })
  for (const dep of nested) {
    res.push(control.txFactory.createTxRemoveDoc(dep._class, dep.space, dep._id))
  }
  const targetAccounts = await control.modelDb.findAll(contact.class.PersonAccount, {
    _id: { $in: department.members }
  })
  const employeeIds = targetAccounts.map((acc) => acc.person as Ref<Staff>)

  const employee = await control.findAll(contact.mixin.Employee, {
    _id: { $in: employeeIds }
  })
  const removed = await buildHierarchy(department._id, control)
  employee.forEach((em) => {
    res.push(control.txFactory.createTxMixin(em._id, em._class, em.space, hr.mixin.Staff, { department: undefined }))
  })
  targetAccounts.forEach((acc) => {
    res.push(
      ...getTxes(
        control.txFactory,
        acc._id,
        [],
        removed.map((p) => p._id)
      )
    )
  })
  return res
}

/**
 * @public
 */
export async function OnEmployee (tx: Tx, control: TriggerControl): Promise<Tx[]> {
  const ctx = TxProcessor.extractTx(tx) as TxMixin<Person, Employee>

  const person = (await control.findAll(contact.class.Person, { _id: ctx.objectId }))[0]
  if (person === undefined) {
    return []
  }

  const employee = control.hierarchy.as(person, ctx.mixin)
  if (control.hierarchy.hasMixin(person, hr.mixin.Staff) || !employee.active) {
    return []
  }

  return [
    control.txFactory.createTxMixin(ctx.objectId, ctx.objectClass, ctx.objectSpace, hr.mixin.Staff, {
      department: hr.ids.Head
    })
  ]
}

/**
 * @public
 */
export async function OnEmployeeDeactivate (tx: Tx, control: TriggerControl): Promise<Tx[]> {
  const actualTx = TxProcessor.extractTx(tx)
  if (core.class.TxUpdateDoc !== actualTx._class) {
    return []
  }
  const ctx = actualTx as TxUpdateDoc<Employee>
  if (ctx.objectClass !== contact.mixin.Employee || ctx.operations.active !== false) {
    return []
  }

  const targetAccount = (
    await control.modelDb.findAll(contact.class.PersonAccount, {
      person: ctx.objectId
    })
  )[0]
  if (targetAccount === undefined) return []
  const lastDepartment = await getOldDepartment(ctx, control)
  if (lastDepartment === undefined) return []

  const removed = await buildHierarchy(lastDepartment, control)
  return getTxes(
    control.txFactory,
    targetAccount._id,
    [],
    removed.map((p) => p._id)
  )
}

async function sendEmailNotifications (
  control: TriggerControl,
  sender: PersonAccount,
  doc: Request | PublicHoliday,
  space: Ref<Department>,
  type: Ref<NotificationType>
): Promise<void> {
  const contacts = new Set<Ref<Contact>>()
  const departments = await buildHierarchy(space, control)
  for (const department of departments) {
    if (department.subscribers === undefined) continue
    for (const subscriber of department.subscribers) {
      contacts.add(subscriber)
    }
  }

  // should respect employee settings
  const accounts = await control.modelDb.findAll(contact.class.PersonAccount, {
    person: { $in: Array.from(contacts.values()) as Ref<Employee>[] }
  })
  for (const account of accounts) {
    const allowed = await isAllowed(control, account._id, type, notification.providers.EmailNotification)
    if (!allowed) {
      contacts.delete(account.person)
    }
  }

  const channels = await control.findAll(contact.class.Channel, {
    provider: contact.channelProvider.Email,
    attachedTo: { $in: Array.from(contacts) }
  })

  const senderPerson = (await control.findAll(contact.class.Person, { _id: sender.person }))[0]

  const senderName = senderPerson !== undefined ? formatName(senderPerson.name, control.branding?.lastNameFirst) : ''
  const content = await getContent(doc, senderName, type, control, '')
  if (content === undefined) return

  for (const channel of channels) {
    await sendEmailNotification(content.text, content.html, content.subject, channel.value)
  }
}

/**
 * @public
 */
export async function OnRequestCreate (tx: Tx, control: TriggerControl): Promise<Tx[]> {
  const ctx = TxProcessor.extractTx(tx) as TxCreateDoc<Request>

  const sender = await getPersonAccountById(ctx.modifiedBy, control)
  if (sender === undefined) return []

  const request = TxProcessor.createDoc2Doc(ctx)

  await sendEmailNotifications(control, sender, request, request.department, hr.ids.CreateRequestNotification)
  return []
}

/**
 * @public
 */
export async function OnRequestUpdate (tx: Tx, control: TriggerControl): Promise<Tx[]> {
  const ctx = TxProcessor.extractTx(tx) as TxUpdateDoc<Request>

  const sender = await getPersonAccountById(ctx.modifiedBy, control)
  if (sender === undefined) return []

  const request = (await control.findAll(hr.class.Request, { _id: ctx.objectId }))[0] as Request
  if (request === undefined) return []

  await sendEmailNotifications(control, sender, request, request.department, hr.ids.UpdateRequestNotification)
  return []
}

/**
 * @public
 */
export async function OnRequestRemove (tx: Tx, control: TriggerControl): Promise<Tx[]> {
  const ctx = TxProcessor.extractTx(tx) as TxCreateDoc<Request>

  const sender = await getPersonAccountById(ctx.modifiedBy, control)
  if (sender === undefined) return []

  const request = control.removedMap.get(ctx.objectId) as Request
  if (request === undefined) return []

  await sendEmailNotifications(control, sender, request, request.department, hr.ids.RemoveRequestNotification)
  return []
}

/**
 * @public
 */
export async function RequestHTMLPresenter (doc: Doc, control: TriggerControl): Promise<string> {
  const request = doc as Request
  const employee = (await control.findAll(contact.mixin.Employee, { _id: request.attachedTo }))[0]
  const who = getName(control.hierarchy, employee, control.branding?.lastNameFirst)
  const type = await translate(control.modelDb.getObject(request.type).label, {})

  const date = tzDateEqual(request.tzDate, request.tzDueDate)
    ? `on ${new Date(fromTzDate(request.tzDate)).toLocaleDateString()}`
    : `from ${new Date(fromTzDate(request.tzDate)).toLocaleDateString()} to ${new Date(
        fromTzDate(request.tzDueDate)
      ).toLocaleDateString()}`

  return `${who} - ${type.toLowerCase()} ${date}`
}

/**
 * @public
 */
export async function RequestTextPresenter (doc: Doc, control: TriggerControl): Promise<string> {
  const request = doc as Request
  const employee = (await control.findAll(contact.mixin.Employee, { _id: request.attachedTo }))[0]
  const who = getName(control.hierarchy, employee, control.branding?.lastNameFirst)
  const type = await translate(control.modelDb.getObject(request.type).label, {})

  const date = tzDateEqual(request.tzDate, request.tzDueDate)
    ? `on ${new Date(fromTzDate(request.tzDate)).toLocaleDateString()}`
    : `from ${new Date(fromTzDate(request.tzDate)).toLocaleDateString()} to ${new Date(
        fromTzDate(request.tzDueDate)
      ).toLocaleDateString()}`

  return `${who} - ${type.toLowerCase()} ${date}`
}

/**
 * @public
 */
export async function OnPublicHolidayCreate (tx: Tx, control: TriggerControl): Promise<Tx[]> {
  const ctx = TxProcessor.extractTx(tx) as TxCreateDoc<PublicHoliday>

  const sender = await getPersonAccountById(ctx.modifiedBy, control)
  if (sender === undefined) return []
  const employee = await getEmployee(sender.person as Ref<Employee>, control)
  if (employee === undefined) return []

  const publicHoliday = TxProcessor.createDoc2Doc(ctx)
  await sendEmailNotifications(
    control,
    sender,
    publicHoliday,
    publicHoliday.department,
    hr.ids.CreatePublicHolidayNotification
  )
  return []
}

/**
 * @public
 */
export async function PublicHolidayHTMLPresenter (doc: Doc, control: TriggerControl): Promise<string> {
  const holiday = doc as PublicHoliday
  const sender = await getPersonAccountById(holiday.modifiedBy, control)
  if (sender === undefined) return ''
  const employee = await getEmployee(sender.person as Ref<Employee>, control)
  if (employee === undefined) return ''
  const who = formatName(employee.name, control.branding?.lastNameFirst)

  const date = `on ${new Date(fromTzDate(holiday.date)).toLocaleDateString()}`

  return `${holiday.title} ${date}<br/>${holiday.description}<br/>Set by ${who}`
}

/**
 * @public
 */
export async function PublicHolidayTextPresenter (doc: Doc, control: TriggerControl): Promise<string> {
  const holiday = doc as PublicHoliday
  const sender = await getPersonAccountById(holiday.modifiedBy, control)
  if (sender === undefined) return ''
  const employee = await getEmployee(sender.person as Ref<Employee>, control)
  if (employee === undefined) return ''
  const who = formatName(employee.name, control.branding?.lastNameFirst)

  const date = `on ${new Date(fromTzDate(holiday.date)).toLocaleDateString()}`

  return `${holiday.title} ${date}. ${holiday.description}. Set by ${who}`
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  trigger: {
    OnEmployee,
    OnRequestCreate,
    OnRequestUpdate,
    OnRequestRemove,
    OnDepartmentStaff,
    OnDepartmentRemove,
    OnEmployeeDeactivate,
    OnPublicHolidayCreate
  },
  function: {
    RequestHTMLPresenter,
    RequestTextPresenter,
    PublicHolidayHTMLPresenter,
    PublicHolidayTextPresenter
  }
})
