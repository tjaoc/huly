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

import { type BackupConfig } from '@hcengineering/server-backup'

interface Config extends Omit<BackupConfig, 'Token'> {
  AccountsURL: string
  ServiceID: string
  Secret: string

  Interval: number // Timeout in seconds
  Timeout: number // Timeout in seconds
  BucketName: string
  Storage: string // A bucket storage config
  WorkspaceStorage: string // A workspace storage config

  SkipWorkspaces: string

  MongoURL: string
}

const envMap: { [key in keyof Config]: string } = {
  AccountsURL: 'ACCOUNTS_URL',
  ServiceID: 'SERVICE_ID',
  Secret: 'SECRET',
  BucketName: 'BUCKET_NAME',
  Interval: 'INTERVAL',
  Timeout: 'TIMEOUT',
  MongoURL: 'MONGO_URL',
  SkipWorkspaces: 'SKIP_WORKSPACES',
  Storage: 'STORAGE',
  WorkspaceStorage: 'WORKSPACE_STORAGE'
}

const required: Array<keyof Config> = [
  'AccountsURL',
  'Secret',
  'ServiceID',
  'BucketName',
  'MongoURL',
  'Storage',
  'WorkspaceStorage'
]

const config: Config = (() => {
  const params: Partial<Config> = {
    AccountsURL: process.env[envMap.AccountsURL],
    Secret: process.env[envMap.Secret],
    BucketName: process.env[envMap.BucketName] ?? 'backups',
    ServiceID: process.env[envMap.ServiceID] ?? 'backup-service',
    Interval: parseInt(process.env[envMap.Interval] ?? '3600'),
    Timeout: parseInt(process.env[envMap.Timeout] ?? '3600'),
    MongoURL: process.env[envMap.MongoURL],
    SkipWorkspaces: process.env[envMap.SkipWorkspaces] ?? '',
    WorkspaceStorage: process.env[envMap.WorkspaceStorage],
    Storage: process.env[envMap.Storage]
  }

  const missingEnv = required.filter((key) => params[key] === undefined).map((key) => envMap[key])

  if (missingEnv.length > 0) {
    throw Error(`Missing env variables: ${missingEnv.join(', ')}`)
  }

  return params as Config
})()

export default config
