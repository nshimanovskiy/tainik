// Сообщение об ошибке входа (?e=bad или ?e=limit)
const e = new URLSearchParams(location.search).get('e');
const node = document.getElementById('error');
if (e === 'bad') node.textContent = 'Неверный пароль';
if (e === 'limit') node.textContent = 'Слишком много попыток. Подождите 15 минут.';
node.hidden = !node.textContent;
