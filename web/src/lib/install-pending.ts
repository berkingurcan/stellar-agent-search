import type { InstallConfig } from './install-types.js';

/**
 * Safe pre-release surface. It intentionally contains no executable package
 * command, so an unclaimed npm name cannot leak through a hidden branch or a
 * downloaded JavaScript chunk.
 */
export const PACKAGE_PUBLISHED = false;
export const HERO_CMD = '';
export const CONFIGS: InstallConfig[] = [
	{ id: 'pending', label: 'Pre-release', lang: 'text', code: '', note: '' }
];
