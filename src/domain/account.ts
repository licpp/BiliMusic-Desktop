export type QrLogin = { key: string; url: string }
export type QrLoginStatus = { status: 'waiting' | 'confirmed' | 'authenticated' | 'expired' | 'error'; message: string }
export type AccountProfile = { loggedIn: boolean; userId?: number; name?: string; avatarUrl?: string; level?: number; vipActive?: boolean }
