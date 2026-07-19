function assertProcessPlatform(
  platform: NodeJS.Platform,
  command: string,
): void {
  if (platform === "win32") {
    throw new Error(
      `${command} requires POSIX process-group ownership; win32 is unsupported`,
    );
  }
}

export { assertProcessPlatform };
