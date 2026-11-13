import { call } from "@decky/api";
import type { QueueState } from "./uploadQueue";

// Decky v1 RPC takes positional arguments; argument objects cannot be spread.
const api = {
  getSetting<T>(args: { key: string; defaults: T }): Promise<T> {
    return call<[string, T], T>("getSetting", args.key, args.defaults);
  },
  putSetting<T>(args: { key: string; value: T }): Promise<void> {
    return call<[string, T], void>("putSetting", args.key, args.value);
  },
  getCounter(args: { key: string }): Promise<number> {
    return call<[string], number>("getCounter", args.key);
  },
  increaseCounter(args: { key: string }): Promise<void> {
    return call<[string], void>("increaseCounter", args.key);
  },
  loadQueue(account: string): Promise<QueueState> {
    return call<[string], QueueState>("loadQueue", account);
  },
  saveQueue(state: QueueState): Promise<number> {
    return call<[QueueState], number>("saveQueue", state);
  },
};
export default api;
