// Вкладка-заглушка: показывает, какое видео уехало, и возвращает его по кнопке.
const title = new URLSearchParams(location.search).get('title') || '';
document.getElementById('what').textContent = title;
if (title) document.title = '📱 ' + title;
document.getElementById('back').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'return' }));
