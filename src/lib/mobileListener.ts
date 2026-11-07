/** Persisted per-instance Mobile Web Host policy; not an Origin/auth override. */
export interface MobileListenerConfig {
  allowed_hosts: string[];
  allow_all_hosts: boolean;
}
