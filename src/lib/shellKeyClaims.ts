/**
 * App-shell keystroke claims.
 *
 * The main layout owns a few window-level chords (macOS Cmd+1..9 switches app
 * tabs). A focused feature surface whose own keymap binds the same chord (the
 * Code Workspace follows IDEA's macOS keymap, where Cmd+1 activates Project)
 * registers a claim here; the shell yields the stroke when the event target is
 * inside that surface and the surface says it binds the stroke.
 */

export type ShellKeyClaim = (event: KeyboardEvent) => boolean;

interface Registration {
  root: Element;
  claims: ShellKeyClaim;
}

const registrations = new Set<Registration>();

export function registerShellKeyClaim(root: Element, claims: ShellKeyClaim): () => void {
  const registration: Registration = { root, claims };
  registrations.add(registration);
  return () => {
    registrations.delete(registration);
  };
}

/** True when a surface containing the event target binds this stroke itself. */
export function shellKeyClaimed(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof Node)) return false;
  for (const registration of registrations) {
    if (!registration.root.contains(target)) continue;
    try {
      if (registration.claims(event)) return true;
    } catch {
      // A failing claim never blocks the shell's own handling.
    }
  }
  return false;
}
