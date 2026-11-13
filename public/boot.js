try { document.documentElement.dataset.theme = localStorage.getItem('bilimusic-theme') === 'light' ? 'light' : 'dark' } catch (_) {}
