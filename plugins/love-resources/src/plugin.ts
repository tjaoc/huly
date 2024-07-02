//
// Copyright © 2024 Hardcore Engineering Inc.
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

import { mergeIds, type IntlString } from '@hcengineering/platform'
import { type AnyComponent } from '@hcengineering/ui'
import love, { loveId } from '@hcengineering/love'

export default mergeIds(loveId, love, {
  component: {
    ControlExt: '' as AnyComponent
  },
  string: {
    LeaveRoom: '' as IntlString,
    LeaveRoomConfirmation: '' as IntlString,
    Mute: '' as IntlString,
    UnMute: '' as IntlString,
    Share: '' as IntlString,
    StopShare: '' as IntlString,
    StartVideo: '' as IntlString,
    StopVideo: '' as IntlString,
    Floors: '' as IntlString,
    Floor: '' as IntlString,
    MyOffice: '' as IntlString,
    EditOffice: '' as IntlString,
    FinalizeEditing: '' as IntlString,
    ChangeFloor: '' as IntlString,
    Accept: '' as IntlString,
    Decline: '' as IntlString,
    ChangeAccess: '' as IntlString,
    AddAFloor: '' as IntlString,
    RenameAFloor: '' as IntlString,
    KnockingTo: '' as IntlString,
    Cancel: '' as IntlString,
    EnterRoom: '' as IntlString,
    Configure: '' as IntlString,
    MeetingRoom: '' as IntlString,
    TeamRoom: '' as IntlString,
    AnotherWindowError: '' as IntlString,
    Speaker: '' as IntlString,
    Microphone: '' as IntlString,
    Camera: '' as IntlString,
    Settings: '' as IntlString,
    LoveDescription: '' as IntlString,
    DefaultDevice: '' as IntlString,
    StartWithMutedMic: '' as IntlString,
    StartWithoutVideo: '' as IntlString,
    YouInivite: '' as IntlString,
    NoiseCancellation: '' as IntlString,
    NoiseCancellationNotSupported: '' as IntlString,
    Blur: '' as IntlString,
    BlurRadius: '' as IntlString,
    BlurTooltip: '' as IntlString,
    GuestLink: '' as IntlString,
    CopyGuestLink: '' as IntlString,
    Record: '' as IntlString,
    StopRecord: '' as IntlString,
    ServiceNotConfigured: '' as IntlString,
    FullscreenMode: '' as IntlString,
    ExitingFullscreenMode: '' as IntlString,
    Invite: '' as IntlString,
    KnockAction: '' as IntlString,
    Select: '' as IntlString,
    ChooseShare: '' as IntlString
  }
})
