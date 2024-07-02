//
// Copyright © 2023 Hardcore Engineering Inc.
//
import { type Builder } from '@hcengineering/model'
import core from '@hcengineering/core'
import serverCore from '@hcengineering/server-core'
import { RequestStatus } from '@hcengineering/request'
import documents, { DocumentState } from '@hcengineering/controlled-documents'
import serverDocuments from '@hcengineering/server-controlled-documents'
import contact from '@hcengineering/contact'
import serverNotification from '@hcengineering/server-notification'

export { serverDocumentsId } from '@hcengineering/server-controlled-documents/src/index'

export function createModel (builder: Builder): void {
  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverDocuments.trigger.OnCollaborativeSectionDeleted,
    txMatch: {
      _class: core.class.TxCollectionCUD,
      'tx.objectClass': documents.class.CollaborativeDocumentSection,
      'tx._class': core.class.TxRemoveDoc
    }
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverDocuments.trigger.OnDocPlannedEffectiveDateChanged,
    txMatch: {
      _class: core.class.TxUpdateDoc,
      objectClass: documents.class.ControlledDocument
    }
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverDocuments.trigger.OnDocApprovalRequestApproved,
    txMatch: {
      _class: core.class.TxCollectionCUD,
      objectClass: documents.class.ControlledDocument,
      'tx._class': core.class.TxUpdateDoc,
      'tx.objectClass': documents.class.DocumentApprovalRequest,
      'tx.operations.status': RequestStatus.Completed
    }
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverDocuments.trigger.OnDocHasBecomeEffective,
    txMatch: {
      _class: core.class.TxUpdateDoc,
      objectClass: documents.class.ControlledDocument,
      'operations.state': DocumentState.Effective
    }
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverDocuments.trigger.OnWorkspaceOwnerAdded,
    txMatch: {
      objectClass: contact.class.PersonAccount
    }
  })

  builder.mixin(documents.class.DocumentMeta, core.class.Class, serverCore.mixin.SearchPresenter, {
    searchConfig: {
      iconConfig: {
        component: documents.component.DocumentIcon,
        props: []
      },
      title: 'title'
    }
  })

  builder.mixin(documents.class.ControlledDocument, core.class.Class, serverNotification.mixin.TextPresenter, {
    presenter: serverDocuments.function.ControlledDocumentTextPresenter
  })
}
