import {
  deriveRepoNameFromUrl,
  isAbsoluteClonePath,
  joinClonePath,
  newGitCloneTaskId,
  validateBranchName,
  validateCloneUrl,
  validateWorkspaceName,
  type GitCloneDefaults,
  type GitCloneProxyMode,
  type GitCloneRequest,
} from "../../../lib/gitClone";

export interface GitCloneFormState {
  url: string;
  name: string;
  location: string;
  branch: string;
  userName: string;
  userEmail: string;
  proxyMode: GitCloneProxyMode;
  httpProxy: string;
  httpsProxy: string;
  token: string;
  tokenUsername: string;
  useSavedToken: boolean;
  rememberToken: boolean;
  showToken: boolean;
  nameTouched: boolean;
  branchTouched: boolean;
}

export interface GitCloneFormErrors {
  url?: "required" | "invalid" | "credentials" | "whitespace";
  name?: "required" | "invalid";
  location?: "required" | "absolute";
  branch?: "invalid";
  proxy?: "required" | "invalid";
  appProxy?: "unavailable";
  git?: "unavailable";
}

export const TOKEN_DEFAULT_USERNAME = "x-access-token";

export function initialCloneForm(defaults: GitCloneDefaults | null): GitCloneFormState {
  const appProxy = defaults?.appProxyUrl?.trim() ?? "";
  const proxyMode: GitCloneProxyMode = defaults?.appProxyEnabled && appProxy
    ? (defaults.appProxyError ? "none" : "app")
    : "none";
  const vaultUnlocked = defaults?.vaultState === "unlocked";
  return {
    url: "",
    name: "",
    location: defaults?.cloneRoot?.trim() ?? "",
    branch: defaults?.defaultBranch?.trim() ?? "main",
    userName: defaults?.userName?.trim() ?? "",
    userEmail: defaults?.userEmail?.trim() ?? "",
    proxyMode,
    httpProxy: proxyMode === "app" ? appProxy : "",
    httpsProxy: proxyMode === "app" ? appProxy : "",
    token: "",
    tokenUsername: TOKEN_DEFAULT_USERNAME,
    useSavedToken: vaultUnlocked && Boolean(defaults?.savedTokenAvailable),
    rememberToken: vaultUnlocked,
    showToken: false,
    nameTouched: false,
    branchTouched: false,
  };
}

/** Apply a changed proxy mode without overwriting the user's custom values. */
export function withProxyMode(
  form: GitCloneFormState,
  mode: GitCloneProxyMode,
  defaults: GitCloneDefaults | null,
): GitCloneFormState {
  const appProxy = defaults?.appProxyUrl?.trim() ?? "";
  if (mode === "app") {
    return { ...form, proxyMode: mode, httpProxy: appProxy, httpsProxy: appProxy };
  }
  if (mode === "none") {
    return { ...form, proxyMode: mode, httpProxy: "", httpsProxy: "" };
  }
  const http = form.httpProxy || appProxy;
  const https = form.httpsProxy || appProxy;
  return { ...form, proxyMode: mode, httpProxy: http, httpsProxy: https };
}

export function autoNameForUrl(form: GitCloneFormState): GitCloneFormState {
  if (form.nameTouched) return form;
  const name = deriveRepoNameFromUrl(form.url);
  return name === form.name ? form : { ...form, name };
}

export function detectedBranchFor(
  form: GitCloneFormState,
  detected: string | null,
): GitCloneFormState {
  if (!detected || form.branchTouched || form.branch.trim() === detected) return form;
  return { ...form, branch: detected };
}

export function cloneDestination(form: GitCloneFormState): string {
  return joinClonePath(form.location, form.name);
}

function validProxyUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return ["http:", "https:", "socks5:"].includes(parsed.protocol) && Boolean(parsed.hostname)
      && !/\s/.test(trimmed);
  } catch {
    return false;
  }
}

export function validateCloneForm(
  form: GitCloneFormState,
  defaults: GitCloneDefaults | null,
): GitCloneFormErrors {
  const errors: GitCloneFormErrors = {};
  const urlError = validateCloneUrl(form.url);
  if (urlError) errors.url = urlError;
  const nameError = validateWorkspaceName(form.name);
  if (nameError) errors.name = nameError;
  const location = form.location.trim();
  if (!location) errors.location = "required";
  else if (!isAbsoluteClonePath(location)) errors.location = "absolute";
  const branchError = validateBranchName(form.branch);
  if (branchError) errors.branch = branchError;
  if (form.proxyMode === "custom") {
    const http = form.httpProxy.trim();
    const https = form.httpsProxy.trim();
    if (!http && !https) errors.proxy = "required";
    else if ((http && !validProxyUrl(http)) || (https && !validProxyUrl(https))) errors.proxy = "invalid";
  }
  if (form.proxyMode === "app" && defaults?.appProxyError) errors.appProxy = "unavailable";
  if (defaults && !defaults.gitAvailable) errors.git = "unavailable";
  return errors;
}

export function hasCloneFormErrors(errors: GitCloneFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function cloneRequestFromForm(
  form: GitCloneFormState,
  taskId = newGitCloneTaskId(),
): GitCloneRequest {
  return {
    taskId,
    url: form.url.trim(),
    destination: cloneDestination(form),
    workspaceName: form.name.trim(),
    branch: form.branch.trim() || null,
    userName: form.userName.trim() || null,
    userEmail: form.userEmail.trim() || null,
    proxyMode: form.proxyMode,
    httpProxy: form.proxyMode === "custom" ? form.httpProxy.trim() || null : null,
    httpsProxy: form.proxyMode === "custom" ? form.httpsProxy.trim() || null : null,
    token: form.token.trim() || null,
    tokenUsername: form.tokenUsername.trim() || null,
    useSavedToken: form.useSavedToken,
    rememberToken: form.rememberToken,
  };
}
