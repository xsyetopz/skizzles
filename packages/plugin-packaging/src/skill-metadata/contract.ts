const KIBIBYTE = 1024;

export class SkillMetadataError extends Error {}
export const SKILL_FILE_MAX_BYTES = 1024 * KIBIBYTE;
export const OPENAI_METADATA_MAX_BYTES = 64 * KIBIBYTE;
export const ICON_ASSET_MAX_BYTES = 5 * 1024 * KIBIBYTE;
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const SKILL_OPTIONAL_TEXT_MAX_LENGTH = 1024;
export const SKILL_METADATA_KEY_MAX_LENGTH = 64;
export const DISPLAY_NAME_MAX_LENGTH = 64;
export const SHORT_DESCRIPTION_MIN_LENGTH = 25;
export const SHORT_DESCRIPTION_MAX_LENGTH = 64;
export const DEFAULT_PROMPT_MAX_LENGTH = 1024;
export const TOOL_TEXT_MAX_LENGTH = 1024;
export const TOOL_IDENTIFIER_MAX_LENGTH = 1024;
export const TRANSPORT_MAX_LENGTH = 64;
export const URL_MAX_LENGTH = 1024;
export const ICON_PATH_MAX_LENGTH = 256;
export const BRAND_COLOR_LENGTH = 7;
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const BRAND_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/u;
export const TOOL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
export const SKILL_METADATA_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface SkillMetadataFile {
  bytes: Uint8Array;
  relativePath: string;
}

export interface SkillAssetBinding extends SkillMetadataFile {
  sha256: string;
}

export interface SkillMetadataRecord {
  directoryName: string;
  openai?: SkillMetadataFile;
  skill: SkillMetadataFile;
}
