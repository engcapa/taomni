export interface PanelActions { promote?(): void | Promise<void>; detach?(): void | Promise<void>; reattach?(): void | Promise<void>; close?(): void | Promise<void>; retry?(): void | Promise<void>; focus?(): void | Promise<void> }
const actions = new Map<string, PanelActions>();
export function registerPanelActions(id: string, value: PanelActions) { actions.set(id, value); return () => { if (actions.get(id) === value) actions.delete(id); }; }
export function getPanelActions(id: string) { return actions.get(id); }
