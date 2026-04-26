import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import JSZip from "jszip";
import { ChevronDown, ChevronRight } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  type BuildConfig,
  createDeployment,
  type Deployment,
  gitPreflight,
  type GitRemoteRef,
  railpackPreflight,
  type RailpackPreflightResult,
  uploadSourceArchive,
} from "#/lib/api";
import { BuildConfigEditor } from "#/components/build-config-editor";
import { EnvVarsEditor, type EnvRow, makeEmptyRow, rowsToMap } from "#/components/env-vars-editor";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Field, FieldDescription, FieldLabel } from "#/components/ui/field";
import { Tabs, TabsList, TabsTab, TabsPanel } from "#/components/ui/tabs";
import { Skeleton } from "#/components/ui/skeleton";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Spinner } from "#/components/ui/spinner";
import { toastManager } from "#/components/ui/toast";
import { cn } from "#/lib/utils";

function reportError(title: string, e: unknown): void {
  toastManager.add({
    type: "error",
    title,
    description: e instanceof Error ? e.message : String(e),
  });
}

type Props = {
  appId?: string;
  initialGitUrl?: string;
  onDeployed: (d: Deployment) => void;
  className?: string;
};

function branchAndTagRefs(refs: GitRemoteRef[]): GitRemoteRef[] {
  return refs.filter((r) => r.type === "branch" || r.type === "tag");
}

/** Paths we never want to bundle when zipping a chosen directory client-side. */
const SKIP_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
  ".DS_Store",
]);

function shouldSkipPath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  return parts.some((p) => SKIP_SEGMENTS.has(p));
}

/** Zip a `webkitdirectory` FileList in the browser; strips the chosen folder's
 *  top-level segment so the archive contents sit at the root (matching how the
 *  server extracts a tarball). */
async function zipDirectory(files: FileList, fallbackName: string): Promise<File> {
  const zip = new JSZip();
  let topPrefix: string | null = null;
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (topPrefix === null) {
      topPrefix = rel.includes("/") ? rel.split("/")[0]! : "";
    }
    const stripped =
      topPrefix && rel.startsWith(`${topPrefix}/`) ? rel.slice(topPrefix.length + 1) : rel;
    if (!stripped || shouldSkipPath(stripped)) continue;
    zip.file(stripped, f);
  }
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const name = `${(topPrefix || fallbackName).replace(/[^a-zA-Z0-9._-]/g, "-")}.zip`;
  return new File([blob], name, { type: "application/zip" });
}

export function DeployForm({ appId, initialGitUrl = "", onDeployed, className }: Props) {
  const q = useQueryClient();
  const [tab, setTab] = useState<"git" | "upload">("git");
  const [gitUrl, setGitUrl] = useState(initialGitUrl);
  const [appName, setAppName] = useState("");
  const [refs, setRefs] = useState<GitRemoteRef[] | null>(null);
  const [refPick, setRefPick] = useState("");
  const [rootDir, setRootDir] = useState("");
  const [uploadKind, setUploadKind] = useState<"archive" | "folder">("archive");
  const [file, setFile] = useState<File | null>(null);
  const [folderFiles, setFolderFiles] = useState<FileList | null>(null);
  const [folderName, setFolderName] = useState<string>("");
  const [zipping, setZipping] = useState(false);
  const [envRows, setEnvRows] = useState<EnvRow[]>([makeEmptyRow()]);
  const [envOpen, setEnvOpen] = useState(false);
  const [buildCfg, setBuildCfg] = useState<BuildConfig>({});
  const [buildCfgOpen, setBuildCfgOpen] = useState(false);
  // track the last URL we ran preflight on to avoid duplicate fetches
  const preflightedUrl = useRef("");

  const preflight = useMutation({
    mutationFn: (url: string) => gitPreflight(url),
    onSuccess: (res) => {
      const b = branchAndTagRefs(res.refs);
      setRefs(b);
      if (b.length) {
        const def = b.find((r) => r.ref === "main" || r.ref === "master");
        setRefPick(def?.ref ?? b[0]!.ref);
      } else {
        setRefPick("");
      }
    },
    onError: (e) => {
      setRefs(null);
      setRefPick("");
      reportError("Failed to list branches", e);
    },
  });

  // Auto-trigger preflight when the URL field loses focus or the user presses Enter
  const maybePreflight = () => {
    const url = gitUrl.trim();
    if (!url || url === preflightedUrl.current) return;
    preflightedUrl.current = url;
    setRefs(null);
    setRefPick("");
    preflight.mutate(url);
  };

  // Reset refs when the URL is cleared or changes significantly
  useEffect(() => {
    if (!gitUrl.trim()) {
      setRefs(null);
      setRefPick("");
      preflightedUrl.current = "";
    }
  }, [gitUrl]);

  /**
   * Railpack preflight — fetches the same defaults the build pipeline would
   * use so the build-config inputs can show them as placeholders.
   *
   * Performance:
   *   - Backed by `useQuery` so the result is cached per-(url, ref). The
   *     server also caches in-process, but this avoids even hitting it on
   *     re-mounts / tab switches.
   *   - `enabled` is gated on the user actually opening the build-config
   *     section in the form. There's no point detecting until they care,
   *     and it makes the common path (just deploy with defaults) free.
   *   - Fails silently — the editor still works without a placeholder.
   */
  const trimmedGitUrl = gitUrl.trim();
  const preflightEnabled =
    buildCfgOpen && tab === "git" && trimmedGitUrl.length > 0 && refPick.length > 0;
  const railpackPreflightQ = useQuery({
    queryKey: ["railpack-preflight", "git", trimmedGitUrl, refPick],
    queryFn: () => railpackPreflight({ gitUrl: trimmedGitUrl, ref: refPick }),
    enabled: preflightEnabled,
    staleTime: 10 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const detectedDefaults: RailpackPreflightResult | null =
    (railpackPreflightQ.data as RailpackPreflightResult | undefined) ?? null;

  const deploy = useMutation({
    mutationFn: createDeployment,
    onSuccess: (d) => {
      void q.invalidateQueries({ queryKey: ["apps"] });
      if (appId) {
        void q.invalidateQueries({ queryKey: ["app", appId] });
        void q.invalidateQueries({ queryKey: ["deployments", appId] });
      }
      onDeployed(d);
    },
    onError: (e) => {
      reportError("Deploy failed", e);
    },
  });

  const onGitSubmit = (e: FormEvent) => {
    e.preventDefault();
    const url = gitUrl.trim();
    if (!url) {
      toastManager.add({ type: "warning", title: "Repository URL is required" });
      return;
    }
    if (!refPick.trim()) {
      toastManager.add({ type: "warning", title: "Select a branch or tag" });
      return;
    }
    const refKind = refs?.find((r) => r.ref === refPick)?.type === "tag" ? "tag" : "branch";
    const envVars = rowsToMap(envRows);
    void deploy.mutateAsync({
      sourceType: "git",
      gitUrl: url,
      ref: refPick,
      refKind,
      appId: appId as string | undefined,
      appName: !appId && appName.trim() ? appName.trim() : undefined,
      envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
      buildCommand: buildCfg.buildCommand?.trim() || undefined,
      startCommand: buildCfg.startCommand?.trim() || undefined,
    });
  };

  const [uploading, setUploading] = useState(false);

  const onUploadSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (uploadKind === "archive" && !file) {
      toastManager.add({ type: "warning", title: "Choose a .zip or .tar.gz archive" });
      return;
    }
    if (uploadKind === "folder" && (!folderFiles || folderFiles.length === 0)) {
      toastManager.add({ type: "warning", title: "Choose a folder to upload" });
      return;
    }
    void (async () => {
      setUploading(true);
      try {
        let toUpload: File;
        if (uploadKind === "folder") {
          setZipping(true);
          toUpload = await zipDirectory(folderFiles!, folderName || "upload");
          setZipping(false);
        } else {
          toUpload = file!;
        }
        const up = await uploadSourceArchive(toUpload);
        const envVars = rowsToMap(envRows);
        const dep = await createDeployment({
          sourceType: "upload",
          filename: up.archivePath,
          rootDirectory: rootDir.trim() || undefined,
          appId: appId as string | undefined,
          appName: !appId && appName.trim() ? appName.trim() : undefined,
          envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
          buildCommand: buildCfg.buildCommand?.trim() || undefined,
          startCommand: buildCfg.startCommand?.trim() || undefined,
        });
        void q.invalidateQueries({ queryKey: ["apps"] });
        if (appId) {
          void q.invalidateQueries({ queryKey: ["app", appId] });
          void q.invalidateQueries({ queryKey: ["deployments", appId] });
        }
        onDeployed(dep);
      } catch (err) {
        reportError("Upload failed", err);
      } finally {
        setZipping(false);
        setUploading(false);
      }
    })();
  };

  const busy = deploy.isPending || uploading;
  const gitDeployDisabled = busy || !gitUrl.trim() || !refPick || preflight.isPending;
  const uploadDisabled =
    busy || (uploadKind === "archive" ? !file : !folderFiles || folderFiles.length === 0);

  return (
    <div className={cn("space-y-4", className)}>
      <Tabs
        onValueChange={(v) => {
          if (v === "git" || v === "upload") setTab(v);
        }}
        value={tab}
      >
        <TabsList>
          <TabsTab value="git">Git</TabsTab>
          <TabsTab value="upload">Upload</TabsTab>
        </TabsList>

        {/* ── Git tab ── */}
        <TabsPanel className="mt-4" value="git">
          <form className="space-y-4" onSubmit={onGitSubmit}>
            <Field>
              <FieldLabel>Repository</FieldLabel>
              <Input
                disabled={busy}
                onBlur={maybePreflight}
                onChange={(e) => setGitUrl(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    maybePreflight();
                  }
                }}
                placeholder="https://github.com/user/repo"
                type="url"
                value={gitUrl}
              />
            </Field>

            {/* Branch/tag selector — only shown after preflight */}
            {preflight.isPending && (
              <Field>
                <FieldLabel>Branch or tag</FieldLabel>
                <Skeleton className="h-9 w-full rounded-lg" />
              </Field>
            )}
            {!preflight.isPending && refs && refs.length > 0 && (
              <Field>
                <FieldLabel>Branch or tag</FieldLabel>
                <Select
                  onValueChange={(v) => {
                    if (v !== null) setRefPick(v);
                  }}
                  value={refPick}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select branch or tag" />
                  </SelectTrigger>
                  <SelectPopup>
                    {refs.map((r) => (
                      <SelectItem key={`${r.type}-${r.ref}`} value={r.ref}>
                        {r.ref}
                        <span className="text-muted-foreground ml-1.5 text-xs">{r.type}</span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            )}
            {!preflight.isPending && refs !== null && refs.length === 0 && (
              <p className="text-muted-foreground text-sm">No branches or tags found.</p>
            )}

            {!appId && (
              <Field>
                <FieldLabel>
                  Project name <span className="text-muted-foreground font-normal">(optional)</span>
                </FieldLabel>
                <Input
                  disabled={busy}
                  onChange={(e) => setAppName(e.currentTarget.value)}
                  placeholder="my-app"
                  value={appName}
                />
              </Field>
            )}

            <EnvSection
              busy={busy}
              envOpen={envOpen}
              envRows={envRows}
              setEnvOpen={setEnvOpen}
              setEnvRows={setEnvRows}
            />

            <BuildConfigSection
              buildCfg={buildCfg}
              busy={busy}
              defaults={detectedDefaults ?? undefined}
              detecting={railpackPreflightQ.isFetching}
              open={buildCfgOpen}
              setBuildCfg={setBuildCfg}
              setOpen={setBuildCfgOpen}
            />

            <div className="flex justify-end">
              <Button disabled={gitDeployDisabled} type="submit">
                {deploy.isPending ? (
                  <>
                    <Spinner className="size-4" />
                    Deploying…
                  </>
                ) : (
                  "Deploy"
                )}
              </Button>
            </div>
          </form>
        </TabsPanel>

        {/* ── Upload tab ── */}
        <TabsPanel className="mt-4" value="upload">
          <form className="space-y-4" onSubmit={onUploadSubmit}>
            {!appId && (
              <Field>
                <FieldLabel>
                  Project name <span className="text-muted-foreground font-normal">(optional)</span>
                </FieldLabel>
                <Input
                  disabled={busy}
                  onChange={(e) => setAppName(e.currentTarget.value)}
                  placeholder="my-app"
                  value={appName}
                />
              </Field>
            )}
            <Field>
              <FieldLabel>Source</FieldLabel>
              <Select
                onValueChange={(v) => {
                  if (v === "archive" || v === "folder") {
                    setUploadKind(v);
                    setFile(null);
                    setFolderFiles(null);
                    setFolderName("");
                  }
                }}
                value={uploadKind}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select source type" />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="archive">Archive (.zip / .tar.gz)</SelectItem>
                  <SelectItem value="folder">Folder</SelectItem>
                </SelectPopup>
              </Select>
            </Field>

            {uploadKind === "archive" ? (
              <Field>
                <FieldLabel>Archive</FieldLabel>
                <Input
                  accept=".zip,.gz,.tgz,.tar.gz,application/zip,application/gzip,application/x-gzip,application/x-tar"
                  className="cursor-pointer"
                  disabled={busy}
                  onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)}
                  type="file"
                />
                <FieldDescription>Supports .zip and .tar.gz archives.</FieldDescription>
              </Field>
            ) : (
              <Field>
                <FieldLabel>Folder</FieldLabel>
                <Input
                  className="cursor-pointer"
                  disabled={busy}
                  onChange={(e) => {
                    const list = e.currentTarget.files;
                    setFolderFiles(list && list.length > 0 ? list : null);
                    if (list && list.length > 0) {
                      const first = list[0]!;
                      const rel = (first as File & { webkitRelativePath?: string })
                        .webkitRelativePath;
                      const top = rel?.split("/")[0] ?? "upload";
                      setFolderName(top);
                    } else {
                      setFolderName("");
                    }
                  }}
                  type="file"
                  {...({
                    webkitdirectory: "",
                    directory: "",
                    mozdirectory: "",
                  } as Record<string, string>)}
                />
                <FieldDescription>
                  {folderFiles && folderFiles.length > 0
                    ? `${folderFiles.length} file${folderFiles.length === 1 ? "" : "s"} selected${folderName ? ` from "${folderName}"` : ""}.`
                    : "Pick a directory; we'll zip it and upload."}
                </FieldDescription>
              </Field>
            )}

            <Field>
              <FieldLabel>
                Subfolder <span className="text-muted-foreground font-normal">(optional)</span>
              </FieldLabel>
              <Input
                disabled={busy}
                onChange={(e) => setRootDir(e.currentTarget.value)}
                placeholder="e.g. packages/web"
                value={rootDir}
              />
              <FieldDescription>
                Uploads are stored on the API host and fed into the build as the source root.
              </FieldDescription>
            </Field>

            <EnvSection
              busy={busy}
              envOpen={envOpen}
              envRows={envRows}
              setEnvOpen={setEnvOpen}
              setEnvRows={setEnvRows}
            />

            <BuildConfigSection
              buildCfg={buildCfg}
              busy={busy}
              defaults={detectedDefaults ?? undefined}
              detecting={railpackPreflightQ.isFetching}
              open={buildCfgOpen}
              setBuildCfg={setBuildCfg}
              setOpen={setBuildCfgOpen}
            />

            <div className="flex justify-end">
              <Button disabled={uploadDisabled} type="submit">
                {zipping ? (
                  <>
                    <Spinner className="size-4" />
                    Zipping…
                  </>
                ) : uploading ? (
                  <>
                    <Spinner className="size-4" />
                    Uploading…
                  </>
                ) : (
                  "Upload & deploy"
                )}
              </Button>
            </div>
          </form>
        </TabsPanel>
      </Tabs>
    </div>
  );
}

type EnvSectionProps = {
  busy: boolean;
  envOpen: boolean;
  envRows: EnvRow[];
  setEnvOpen: (v: boolean) => void;
  setEnvRows: (v: EnvRow[]) => void;
};

function EnvSection({ busy, envOpen, envRows, setEnvOpen, setEnvRows }: EnvSectionProps) {
  const filledCount = envRows.filter((r) => r.key.trim()).length;
  return (
    <div className="border-border/60 rounded-lg border">
      <button
        type="button"
        onClick={() => setEnvOpen(!envOpen)}
        className="hover:bg-muted/30 flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left transition-colors"
      >
        <span className="flex items-center gap-2 text-sm">
          {envOpen ? (
            <ChevronDown className="text-muted-foreground size-4" />
          ) : (
            <ChevronRight className="text-muted-foreground size-4" />
          )}
          Environment variables
          {filledCount > 0 && (
            <span className="text-muted-foreground/80 text-xs">({filledCount})</span>
          )}
        </span>
        <span className="text-muted-foreground/80 text-xs">Optional</span>
      </button>
      {envOpen && (
        <div className="border-border/60 border-t px-3 py-3">
          <EnvVarsEditor disabled={busy} onChange={setEnvRows} rows={envRows} />
        </div>
      )}
    </div>
  );
}

type BuildConfigSectionProps = {
  buildCfg: BuildConfig;
  busy: boolean;
  defaults?: RailpackPreflightResult;
  detecting?: boolean;
  open: boolean;
  setBuildCfg: (next: BuildConfig) => void;
  setOpen: (v: boolean) => void;
};

function BuildConfigSection({
  buildCfg,
  busy,
  defaults,
  detecting,
  open,
  setBuildCfg,
  setOpen,
}: BuildConfigSectionProps) {
  const overrideCount =
    (buildCfg.buildCommand?.trim() ? 1 : 0) + (buildCfg.startCommand?.trim() ? 1 : 0);
  return (
    <div className="border-border/60 rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="hover:bg-muted/30 flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left transition-colors"
      >
        <span className="flex items-center gap-2 text-sm">
          {open ? (
            <ChevronDown className="text-muted-foreground size-4" />
          ) : (
            <ChevronRight className="text-muted-foreground size-4" />
          )}
          Build & start commands
          {overrideCount > 0 && (
            <span className="text-muted-foreground/80 text-xs">
              ({overrideCount} override{overrideCount === 1 ? "" : "s"})
            </span>
          )}
        </span>
        <span className="text-muted-foreground/80 text-xs">
          {detecting ? "Detecting…" : "Optional"}
        </span>
      </button>
      {open && (
        <div className="border-border/60 border-t px-3 py-3">
          <BuildConfigEditor
            compact
            defaults={defaults}
            disabled={busy}
            onChange={setBuildCfg}
            value={buildCfg}
          />
          {defaults?.detectedProvider ? (
            <p className="text-muted-foreground/80 mt-2 text-xs">
              Detected provider: <span className="font-mono">{defaults.detectedProvider}</span>
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
