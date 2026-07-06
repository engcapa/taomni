// Wire types for the object-storage feature (S3 / S3-compatible / Azure Blob).
// These mirror the Rust DTOs in `src-tauri/src/objectstorage/{config,types}.rs`
// (all serialized camelCase).

import type { NetworkSettingsPayload } from "../lib/networkSettings";

/** S3-family providers plus Azure. `custom` = arbitrary S3-compatible endpoint. */
export type ObjectStorageProvider =
  | "aws"
  | "alibaba-oss"
  | "minio"
  | "r2"
  | "backblaze"
  | "wasabi"
  | "tencent-cos"
  | "ceph"
  | "custom"
  | "azure";

/** Which engine a provider maps to. */
export type ObjectStorageEngine = "s3" | "azure";

export function engineForProvider(provider: ObjectStorageProvider): ObjectStorageEngine {
  return provider === "azure" ? "azure" : "s3";
}

/**
 * Connection parameters sent to the backend (`storage_attach` / the session's
 * `options_json`). Secret-bearing fields may be `vault:<uuid>` references that
 * the backend resolves; the editor stores them as vault refs on save.
 */
export interface ObjectStorageConfig {
  provider: ObjectStorageProvider;
  // --- S3 family ---
  endpoint?: string | null;
  region?: string | null;
  pathStyle?: boolean | null;
  accessKeyId?: string | null;
  secretAccessKey?: string | null;
  sessionToken?: string | null;
  defaultBucket?: string | null;
  /** S3 credential source: "keys" (default) | "environment" | "profile". */
  awsAuth?: AwsAuthSource | null;
  /** Named AWS profile when awsAuth === "profile". */
  awsProfile?: string | null;
  // --- Azure ---
  accountName?: string | null;
  accountKey?: string | null;
  connectionString?: string | null;
  sasToken?: string | null;
  endpointSuffix?: string | null;
  defaultContainer?: string | null;
  /** Azure auth selector: "key" | "sas" | "connstr" | "bearer" (Entra ID). */
  azureAuth?: AzureAuthSource | null;
  /** Pasted Entra ID token for azureAuth === "bearer" (may be a vault ref). */
  azureBearerToken?: string | null;
  // --- Network routing (P7) ---
  /** Proxy / SSH-jump routing; omitted = app-level global proxy. */
  network?: NetworkSettingsPayload | null;
  // --- Defaults (P8) ---
  /** Default storage class / access tier for uploads (e.g. STANDARD, Hot). */
  storageClass?: string | null;
}

/** S3 credential source. */
export type AwsAuthSource = "keys" | "environment" | "profile";

/** Azure auth source. `key`/`sas`/`connstr` use a stored secret; `bearer` is
 *  Entra ID (a pasted token or one obtained from the Azure CLI). */
export type AzureAuthSource = "key" | "sas" | "connstr" | "bearer";

/** A bucket (S3) or container (Azure) at the account/service root. */
export interface BucketEntry {
  name: string;
  /** Creation time, seconds since the UNIX epoch, when reported. */
  createdAt?: number | null;
  region?: string | null;
}

/** One row in an object listing: a real object or a synthetic folder. */
export interface ObjectEntry {
  name: string;
  key: string;
  isDir: boolean;
  size: number;
  lastModified?: number | null;
  etag?: string | null;
  storageClass?: string | null;
}

/** One page of an object listing; `nextToken` drives lazy pagination. */
export interface ObjectListPage {
  entries: ObjectEntry[];
  nextToken?: string | null;
}

/** Detailed metadata for a single object, from a HEAD request. */
export interface ObjectMetadata {
  key: string;
  size: number;
  contentType?: string | null;
  etag?: string | null;
  lastModified?: number | null;
  storageClass?: string | null;
  cacheControl?: string | null;
  contentEncoding?: string | null;
  contentDisposition?: string | null;
  userMetadata: Record<string, string>;
}

/** Provider presets used by the connection editor (label + defaults). */
export interface ProviderPreset {
  id: ObjectStorageProvider;
  label: string;
  engine: ObjectStorageEngine;
  /** Default addressing style for S3 providers (true = path-style). */
  pathStyle?: boolean;
  /** Endpoint placeholder/hint shown in the editor. */
  endpointHint?: string;
  /** Whether the endpoint is derived (AWS) rather than user-entered. */
  endpointDerived?: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "aws", label: "Amazon S3", engine: "s3", endpointDerived: true },
  { id: "alibaba-oss", label: "Alibaba Cloud OSS", engine: "s3", endpointHint: "oss-cn-hangzhou.aliyuncs.com" },
  { id: "minio", label: "MinIO", engine: "s3", pathStyle: true, endpointHint: "http://127.0.0.1:9000" },
  { id: "r2", label: "Cloudflare R2", engine: "s3", endpointHint: "https://<account>.r2.cloudflarestorage.com" },
  { id: "backblaze", label: "Backblaze B2", engine: "s3", endpointHint: "https://s3.<region>.backblazeb2.com" },
  { id: "wasabi", label: "Wasabi", engine: "s3", endpointHint: "https://s3.<region>.wasabisys.com" },
  { id: "tencent-cos", label: "Tencent COS", engine: "s3", endpointHint: "https://cos.<region>.myqcloud.com" },
  { id: "ceph", label: "Ceph RGW", engine: "s3", pathStyle: true, endpointHint: "https://rgw.example.com" },
  { id: "custom", label: "Custom S3-compatible", engine: "s3", pathStyle: true, endpointHint: "https://s3.example.com" },
  { id: "azure", label: "Azure Blob Storage", engine: "azure" },
];

export function presetFor(provider: ObjectStorageProvider): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === provider) ?? PROVIDER_PRESETS[0];
}

interface BucketEndpointParts {
  bucket: string;
  endpoint: string;
}

function s3BucketEndpointMarkers(provider: ObjectStorageProvider): string[] {
  switch (provider) {
    case "tencent-cos":
      return [".cos."];
    case "alibaba-oss":
      return [".oss-", ".oss."];
    default:
      return [];
  }
}

function parseEndpointUrl(endpoint: string): URL | null {
  try {
    return new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`);
  } catch {
    return null;
  }
}

function splitBucketEndpoint(provider: ObjectStorageProvider, endpoint: string): BucketEndpointParts | null {
  const markers = s3BucketEndpointMarkers(provider);
  if (!markers.length) return null;

  const url = parseEndpointUrl(endpoint);
  if (!url) return null;
  const host = url.hostname.toLowerCase();

  for (const marker of markers) {
    const idx = host.indexOf(marker);
    if (idx <= 0) continue;
    const bucket = host.slice(0, idx);
    const serviceHost = host.slice(idx + 1);
    url.hostname = serviceHost;
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return { bucket, endpoint: url.toString() };
  }

  return null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

export function normalizeObjectStorageConfig(config: ObjectStorageConfig): ObjectStorageConfig {
  if (engineForProvider(config.provider) !== "s3") return config;

  const endpoint = nonEmpty(config.endpoint);
  if (!endpoint) return config;

  const parts = splitBucketEndpoint(config.provider, endpoint);
  if (!parts) return config;

  return {
    ...config,
    endpoint: parts.endpoint,
    defaultBucket: nonEmpty(config.defaultBucket) ?? parts.bucket,
  };
}
