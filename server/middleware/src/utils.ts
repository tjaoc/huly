//
// Copyright © 2023 Hardcore Engineering Inc.
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

import core, { Account, AccountRole, systemAccountEmail } from '@hcengineering/core'
import platform, { PlatformError, Severity, Status } from '@hcengineering/platform'
import { SessionContext, type ServerStorage } from '@hcengineering/server-core'

export async function getUser (storage: ServerStorage, ctx: SessionContext): Promise<Account> {
  if (ctx.userEmail === undefined) {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }
  const account = (await storage.modelDb.findAll(core.class.Account, { email: ctx.userEmail }))[0]
  if (account === undefined) {
    if (ctx.userEmail === systemAccountEmail || ctx.admin === true) {
      return {
        _id: core.account.System,
        _class: core.class.Account,
        role: AccountRole.Owner,
        email: systemAccountEmail,
        space: core.space.Model,
        modifiedBy: core.account.System,
        modifiedOn: 0
      }
    }
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }
  return account
}

export function isOwner (account: Account, ctx: SessionContext): boolean {
  return account.role === AccountRole.Owner || account._id === core.account.System || ctx.admin === true
}

export function isSystem (account: Account): boolean {
  return account._id === core.account.System
}
