# Дашборд черг Asterisk

Заміна MonAst: живий стан черг 1648 / 1548 / Уповноважений, IVR і розмови, статистика за сьогодні,
повітряна тривога, ролі «оператор» і «адміністратор».

- `src/ami.js` — клієнт Asterisk Manager Interface
- `src/state.js` — живий стан з подій AMI (черги, оператори, IVR, розмови)
- `src/stats.js` — статистика з MySQL (`queue_log`, `cdr`) і прапорець тривоги (`monitoring.alerts`)
- `src/server.js` — веб-сервер, вхід, WebSocket, дії адміна
- `public/` — сторінка дашборду
- `tools/fake-ami.js` — фейковий Asterisk для перевірки
- `deploy/` — сервіс systemd, AMI-користувач, користувач MySQL, перевірочний SQL

Встановлення: див. [INSTALL.md](INSTALL.md).
