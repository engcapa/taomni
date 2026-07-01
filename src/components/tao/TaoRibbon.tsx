/**
 * Tao Ribbon — the single edge-docked entry point to the Tao Hub (Chat + Notes).
 *
 * Phase 3 (see tao-notes-feature-plan.md §7 / §11) abstracts the ribbon into a
 * unified `TaoRibbon` while deliberately reusing the existing, battle-tested
 * chat-drawer ribbon implementation so the current Chat open/hover behavior does
 * not regress. The ribbon now docks to any of the four window edges at a
 * fractional offset (see ../../lib/tao/ribbonPlacement). Later phases layer the
 * Tao Hub drawer and alert badges on top of this component.
 */
export { ChatDrawerRibbon as TaoRibbon } from "../chat/ChatDrawer";
