// Собирает всё приложение в один HTML-файл (для публикации или отправки по почте):
//   node build-single.js [выходной файл]
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const out = process.argv[2] || path.join(dir, 'dist', 'bank-payments.html');
let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  const code = fs.readFileSync(path.join(dir, src), 'utf8').replace(/<\/script/gi, '<\\/script');
  return `<script>\n${code}\n</script>`;
});
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('OK', out, html.length, 'байт');
