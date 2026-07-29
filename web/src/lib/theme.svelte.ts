// Ported verbatim from stellar8004.com so both sites honour the same
// `theme` localStorage key and the same light/dark/system tri-state.
export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'theme';
const browser = typeof window !== 'undefined';

function getSystemTheme(): ResolvedTheme {
	if (!browser) return 'dark';
	return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function createThemeStore() {
	let choice = $state<ThemeChoice>('system');
	let resolved = $state<ResolvedTheme>('dark');
	let initialized = false;

	function apply(next: ResolvedTheme) {
		if (resolved === next) return;
		resolved = next;
		if (!browser) return;
		document.documentElement.classList.add('theme-transitioning');
		document.documentElement.setAttribute('data-theme', next);
		requestAnimationFrame(() => {
			setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 250);
		});
	}

	function set(newChoice: ThemeChoice) {
		choice = newChoice;
		if (browser) {
			if (newChoice === 'system') {
				localStorage.removeItem(STORAGE_KEY);
			} else {
				localStorage.setItem(STORAGE_KEY, newChoice);
			}
		}
		apply(newChoice === 'system' ? getSystemTheme() : newChoice);
	}

	function init() {
		if (!browser || initialized) return;
		initialized = true;

		const stored = localStorage.getItem(STORAGE_KEY) as ThemeChoice | null;
		if (stored === 'light' || stored === 'dark') {
			choice = stored;
			resolved = stored;
		} else {
			choice = 'system';
			resolved = getSystemTheme();
		}

		const mql = window.matchMedia('(prefers-color-scheme: light)');
		mql.addEventListener('change', () => {
			if (choice === 'system') apply(getSystemTheme());
		});
	}

	return {
		get choice() {
			return choice;
		},
		get resolved() {
			return resolved;
		},
		set,
		init
	};
}

export const theme = createThemeStore();
