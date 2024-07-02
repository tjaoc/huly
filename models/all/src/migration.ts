//
// Copyright © 2020 Anticrm Platform Contributors.
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

// Import migrate operations.
import { type MigrateOperation } from '@hcengineering/model'
import { attachmentOperation } from '@hcengineering/model-attachment'
import { chunterOperation } from '@hcengineering/model-chunter'
import { contactOperation } from '@hcengineering/model-contact'
import { guestOperation } from '@hcengineering/model-guest'
import { coreOperation } from '@hcengineering/model-core'
import { gmailOperation } from '@hcengineering/model-gmail'
import { leadOperation } from '@hcengineering/model-lead'
import { preferenceOperation } from '@hcengineering/model-preference'
import { notificationOperation } from '@hcengineering/model-notification'
import { settingOperation } from '@hcengineering/model-setting'
import { recruitOperation } from '@hcengineering/model-recruit'
import { tagsOperation } from '@hcengineering/model-tags'
import { taskOperation } from '@hcengineering/model-task'
import { inventoryOperation } from '@hcengineering/model-inventory'
import { telegramOperation } from '@hcengineering/model-telegram'
import { templatesOperation } from '@hcengineering/model-templates'
import { viewOperation } from '@hcengineering/model-view'
import { trackerOperation } from '@hcengineering/model-tracker'
import { boardOperation } from '@hcengineering/model-board'
import { hrOperation } from '@hcengineering/model-hr'
import { bitrixOperation } from '@hcengineering/model-bitrix'
import { calendarOperation } from '@hcengineering/model-calendar'
import { timeOperation } from '@hcengineering/model-time'
import { activityOperation } from '@hcengineering/model-activity'
import { activityServerOperation } from '@hcengineering/model-server-activity'
import { loveId, loveOperation } from '@hcengineering/model-love'
import { documentOperation } from '@hcengineering/model-document'
import { textEditorOperation } from '@hcengineering/model-text-editor'
import { questionsOperation } from '@hcengineering/model-questions'
import { trainingOperation } from '@hcengineering/model-training'
import { documentsOperation } from '@hcengineering/model-controlled-documents'
import { productsOperation } from '@hcengineering/model-products'

export const migrateOperations: [string, MigrateOperation][] = [
  ['core', coreOperation],
  ['activity', activityOperation],
  ['chunter', chunterOperation],
  ['calendar', calendarOperation],
  ['gmail', gmailOperation],
  ['templates', templatesOperation],
  ['telegram', telegramOperation],
  ['task', taskOperation],
  ['attachment', attachmentOperation],
  ['lead', leadOperation],
  ['preference', preferenceOperation],
  ['recruit', recruitOperation],
  ['view', viewOperation],
  ['contact', contactOperation],
  ['guest', guestOperation],
  ['tags', tagsOperation],
  ['setting', settingOperation],
  ['tracker', trackerOperation],
  ['documents', documentsOperation],
  ['questions', questionsOperation],
  ['training', trainingOperation],
  ['products', productsOperation],
  ['board', boardOperation],
  ['hr', hrOperation],
  ['bitrix', bitrixOperation],
  ['inventiry', inventoryOperation],
  ['time', timeOperation],
  ['activityServer', activityServerOperation],
  [loveId, loveOperation],
  ['document', documentOperation],
  ['textEditor', textEditorOperation],
  // We should call it after activityServer and chunter
  ['notification', notificationOperation]
]
