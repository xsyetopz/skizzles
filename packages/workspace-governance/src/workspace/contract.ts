export interface WorkspaceFinding {
  code: string;
  path: string;
  message: string;
}

export interface WorkspacePolicyOptions {
  expectedPackageNames?: readonly string[];
}

export interface PackageManifest {
  name: string;
  version: string;
  private: boolean;
  type: "module";
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  exports: Record<string, string>;
  bin: Record<string, string>;
}

export interface WorkspaceManifest extends PackageManifest {
  workspaces: string[];
}

export interface WorkspacePackage {
  root: string;
  relativeRoot: string;
  manifest: PackageManifest;
}

export function addFinding(
  findings: WorkspaceFinding[],
  code: string,
  path: string,
  message: string,
): void {
  findings.push({ code, path, message });
}

export function compareFindings(
  left: WorkspaceFinding,
  right: WorkspaceFinding,
): number {
  return `${left.path}\0${left.code}`.localeCompare(
    `${right.path}\0${right.code}`,
    "en",
  );
}
