export const tauriOhosPluginInitialize: (callback: (request: string) => void, files: string, cache: string, temp: string) => void;
export const tauriOhosPluginResponse: (id: number, success: boolean, payload: string) => void;
export const tauriOhosPluginClose: () => void;
export const bilimusicOhosState: (payload: string) => void;
export const bilimusicOhosListening: (payload: string) => void;
