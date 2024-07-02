import { Person } from '@hcengineering/contact'
import { Class, Doc, Ref } from '@hcengineering/core'
import { Drive } from '@hcengineering/drive'
import { NotificationType } from '@hcengineering/notification'
import { Asset, IntlString, Metadata, Plugin, plugin } from '@hcengineering/platform'
import { Preference } from '@hcengineering/preference'
import { AnyComponent } from '@hcengineering/ui/src/types'
import { Action } from '@hcengineering/view'

export const loveId = 'love' as Plugin
export type { ScreenSource } from './utils'
export const GRID_WIDTH = 15

export enum RoomAccess {
  Open,
  Knock,
  DND
}

export enum RoomType {
  Video,
  Audio,
  Reception
}

export interface Floor extends Doc {
  name: string
}

export interface Room extends Doc {
  name: string
  type: RoomType
  access: RoomAccess
  floor: Ref<Floor>
  width: number
  height: number
  x: number
  y: number
}

export interface Office extends Room {
  person: Ref<Person> | null
}

// transient data for status
export interface ParticipantInfo extends Doc {
  // isActive: boolean (disabled until server connection to check it for all active rooms)
  person: Ref<Person>
  name: string
  room: Ref<Room>
  x: number
  y: number
}

export interface RoomInfo extends Doc {
  persons: Ref<Person>[]
  room: Ref<Room>
  isOffice: boolean
}

export enum RequestStatus {
  Pending,
  Approved,
  Rejected
}

export interface JoinRequest extends Doc {
  person: Ref<Person>
  room: Ref<Room>
  status: RequestStatus
}

export interface Invite extends Doc {
  from: Ref<Person>
  target: Ref<Person>
  room: Ref<Room>
  status: RequestStatus
}

export interface DevicesPreference extends Preference {
  micEnabled: boolean
  noiseCancellation: boolean
  blurRadius: number
  camEnabled: boolean
}

export * from './utils'

const love = plugin(loveId, {
  class: {
    Room: '' as Ref<Class<Room>>,
    Floor: '' as Ref<Class<Floor>>,
    Office: '' as Ref<Class<Office>>,
    ParticipantInfo: '' as Ref<Class<ParticipantInfo>>,
    JoinRequest: '' as Ref<Class<JoinRequest>>,
    DevicesPreference: '' as Ref<Class<DevicesPreference>>,
    RoomInfo: '' as Ref<Class<RoomInfo>>,
    Invite: '' as Ref<Class<Invite>>
  },
  action: {
    ToggleMic: '' as Ref<Action>,
    ToggleVideo: '' as Ref<Action>
  },
  string: {
    Office: '' as IntlString,
    Room: '' as IntlString,
    IsKnocking: '' as IntlString,
    KnockingLabel: '' as IntlString,
    InivitingLabel: '' as IntlString,
    InvitingYou: '' as IntlString,
    RoomType: '' as IntlString,
    Knock: '' as IntlString,
    Open: '' as IntlString,
    DND: '' as IntlString
  },
  ids: {
    MainFloor: '' as Ref<Floor>,
    Reception: '' as Ref<Room>,
    InviteNotification: '' as Ref<NotificationType>,
    KnockNotification: '' as Ref<NotificationType>
  },
  icon: {
    Love: '' as Asset,
    LeaveRoom: '' as Asset,
    EnterRoom: '' as Asset,
    Mic: '' as Asset,
    MicEnabled: '' as Asset,
    MicDisabled: '' as Asset,
    Cam: '' as Asset,
    CamEnabled: '' as Asset,
    CamDisabled: '' as Asset,
    SharingEnabled: '' as Asset,
    SharingDisabled: '' as Asset,
    Open: '' as Asset,
    Knock: '' as Asset,
    DND: '' as Asset,
    Record: '' as Asset,
    StopRecord: '' as Asset,
    FullScreen: '' as Asset,
    ExitFullScreen: '' as Asset,
    Invite: '' as Asset
  },
  metadata: {
    WebSocketURL: '' as Metadata<string>,
    ServiceEnpdoint: '' as Metadata<string>
  },
  space: {
    Drive: '' as Ref<Drive>
  },
  component: {
    SelectScreenSourcePopup: '' as AnyComponent
  }
})

export const roomAccessIcon = {
  [RoomAccess.Open]: love.icon.Open,
  [RoomAccess.Knock]: love.icon.Knock,
  [RoomAccess.DND]: love.icon.DND
}

export const roomAccessLabel = {
  [RoomAccess.Open]: love.string.Open,
  [RoomAccess.Knock]: love.string.Knock,
  [RoomAccess.DND]: love.string.DND
}

export default love
