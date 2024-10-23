//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
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

import {
  AccountRole,
  DOMAIN_BENCHMARK,
  DOMAIN_BLOB,
  DOMAIN_CONFIGURATION,
  DOMAIN_DOC_INDEX_STATE,
  DOMAIN_MIGRATION,
  DOMAIN_SPACE,
  DOMAIN_STATUS,
  DOMAIN_TRANSIENT,
  DOMAIN_TX,
  systemAccountEmail,
  type AttachedDoc,
  type Class,
  type Doc,
  type IndexingConfiguration,
  type TxCollectionCUD
} from '@hcengineering/core'
import { type Builder } from '@hcengineering/model'
import { TBenchmarkDoc } from './benchmark'
import core from './component'
import {
  TArrOf,
  TAttachedDoc,
  TAttribute,
  TBlob,
  TClass,
  TCollection,
  TConfiguration,
  TConfigurationElement,
  TDoc,
  TCard,
  TDocIndexState,
  TDomainIndexConfiguration,
  TEnum,
  TEnumOf,
  TFullTextSearchContext,
  TIndexConfiguration,
  TInterface,
  TMigrationState,
  TMixin,
  TObj,
  TPluginConfiguration,
  TRefTo,
  TType,
  TTypeAny,
  TTypeBlob,
  TTypeBoolean,
  TTypeCollaborativeDoc,
  TTypeCollaborativeDocVersion,
  TTypeDate,
  TTypeFileSize,
  TTypeHyperlink,
  TTypeIntlString,
  TTypeMarkup,
  TTypeNumber,
  TTypeRank,
  TTypeRecord,
  TTypeRelatedDocument,
  TTypeString,
  TTypeTimestamp,
  TVersion
} from './core'
import { definePermissions } from './permissions'
import {
  TAccount,
  TPermission,
  TRole,
  TSpace,
  TSpaceType,
  TSpaceTypeDescriptor,
  TSystemSpace,
  TTypedSpace
} from './security'
import { defineSpaceType } from './spaceType'
import { TDomainStatusPlaceholder, TStatus, TStatusCategory } from './status'
import { TUserStatus } from './transient'
import {
  TTx,
  TTxApplyIf,
  TTxCollectionCUD,
  TTxCreateDoc,
  TTxCUD,
  TTxMixin,
  TTxRemoveDoc,
  TTxUpdateDoc,
  TTxWorkspaceEvent
} from './tx'

export { coreId, DOMAIN_SPACE } from '@hcengineering/core'
export * from './core'
export { coreOperation } from './migration'
export * from './security'
export * from './status'
export * from './tx'
export { core as default }

export function createModel (builder: Builder): void {
  builder.createModel(
    TObj,
    TDoc,
    TClass,
    TMixin,
    TInterface,
    TTx,
    TTxCUD,
    TTxCreateDoc,
    TAttachedDoc,
    TTxCollectionCUD,
    TTxMixin,
    TTxUpdateDoc,
    TTxRemoveDoc,
    TTxApplyIf,
    TTxWorkspaceEvent,
    TSpace,
    TSystemSpace,
    TTypedSpace,
    TSpaceType,
    TSpaceTypeDescriptor,
    TRole,
    TPermission,
    TAccount,
    TAttribute,
    TType,
    TEnumOf,
    TTypeMarkup,
    TTypeCollaborativeDoc,
    TTypeCollaborativeDocVersion,
    TArrOf,
    TRefTo,
    TTypeDate,
    TTypeFileSize,
    TTypeTimestamp,
    TTypeNumber,
    TTypeBoolean,
    TTypeString,
    TTypeRank,
    TTypeRecord,
    TTypeBlob,
    TTypeHyperlink,
    TCollection,
    TVersion,
    TTypeIntlString,
    TPluginConfiguration,
    TUserStatus,
    TEnum,
    TTypeAny,
    TTypeRelatedDocument,
    TCard,
    TDocIndexState,
    TFullTextSearchContext,
    TConfiguration,
    TConfigurationElement,
    TIndexConfiguration,
    TStatus,
    TDomainStatusPlaceholder,
    TStatusCategory,
    TMigrationState,
    TBlob,
    TDomainIndexConfiguration,
    TBenchmarkDoc
  )

  builder.createDoc(
    core.class.Account,
    core.space.Model,
    {
      email: systemAccountEmail,
      role: AccountRole.Owner
    },
    core.account.System
  )

  builder.mixin<Class<TxCollectionCUD<Doc, AttachedDoc>>, IndexingConfiguration<TxCollectionCUD<Doc, AttachedDoc>>>(
    core.class.TxCollectionCUD,
    core.class.Class,
    core.mixin.IndexConfiguration,
    {
      indexes: ['tx.objectId', 'tx.operations.attachedTo']
    }
  )
  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_TX,
    disabled: [
      { _class: 1 },
      { space: 1 },
      { objectClass: 1 },
      { createdBy: 1 },
      { createdBy: -1 },
      { createdOn: -1 },
      { modifiedBy: 1 }
    ],
    indexes: [
      {
        keys: {
          objectSpace: 1
        }
      }
    ]
  })

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_TRANSIENT,
    disableCollection: true,
    disabled: [
      { _id: 1 },
      { space: 1 },
      { objectClass: 1 },
      { modifiedBy: 1 },
      { createdBy: 1 },
      { createdBy: -1 },
      { createdOn: -1 }
    ]
  })

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_BENCHMARK,
    disableCollection: true,
    disabled: []
  })

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_CONFIGURATION,
    disabled: [
      { _class: 1 },
      { space: 1 },
      { modifiedOn: 1 },
      { modifiedBy: 1 },
      { createdBy: 1 },
      { createdBy: -1 },
      { createdOn: -1 }
    ]
  })

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_MIGRATION,
    disabled: [
      { _class: 1 },
      { space: 1 },
      { modifiedOn: 1 },
      { modifiedBy: 1 },
      { createdBy: 1 },
      { createdBy: -1 },
      { createdOn: -1 }
    ]
  })

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_STATUS,
    disabled: [
      { modifiedOn: 1 },
      { modifiedBy: 1 },
      { createdBy: 1 },
      { createdBy: -1 },
      { createdOn: -1 },
      { space: 1 }
    ]
  })
  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_SPACE,
    disabled: [{ space: 1 }, { modifiedBy: 1 }, { createdBy: 1 }, { createdBy: -1 }, { createdOn: -1 }]
  })

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_BLOB,
    disabled: [
      { _class: 1 },
      { space: 1 },
      { modifiedBy: 1 },
      { createdBy: 1 },
      { createdBy: -1 },
      { createdOn: -1 },
      { modifiedOn: 1 }
    ]
  })

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_DOC_INDEX_STATE,
    indexes: [
      {
        keys: { needIndex: 1 }
      }
    ],
    disabled: [
      { attachedToClass: 1 },
      { stages: 1 },
      { generationId: 1 },
      { space: 1 },
      { _class: 1 },
      { modifiedBy: 1 },
      { createdBy: 1 },
      { createdBy: -1 },
      { createdOn: -1 }
    ]
  })

  builder.createDoc(core.class.FullTextSearchContext, core.space.Model, {
    toClass: core.class.Space,
    childProcessingAllowed: false
  })

  definePermissions(builder)
  defineSpaceType(builder)
}
