// Runs before first paint so the theme never flashes. Mirrors stellar8004.com.
(function () {
	var selectedTheme = localStorage.getItem('theme');
	if (selectedTheme === 'light' || selectedTheme === 'dark') {
		document.documentElement.setAttribute('data-theme', selectedTheme);
	} else {
		document.documentElement.setAttribute(
			'data-theme',
			window.matchMedia('(prefers-color-scheme:light)').matches ? 'light' : 'dark'
		);
	}
})();
