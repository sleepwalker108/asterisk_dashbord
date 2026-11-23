# Встановлення дашборду черг

Схема:

```
браузери і телевізори ──HTTP/WebSocket──▶ сервер дашборду :8080
                                            │  AMI 5038 (події, пауза/додати/видалити)
                                            │  MySQL 3306 (лише читання)
                                            ▼
                                     сервер Asterisk (черги)
```

Нижче `IP_ASTERISK` — адреса сервера Asterisk з чергами, `IP_ДАШБОРДУ` — адреса віртуалки дашборду.

> Кожна команда підписана, **на якій машині** її виконувати. Перевіряйте запрошення в терміналі
> (`root@<ім'я-машини>`), перш ніж вставляти команду.

---

## 1. Віртуалка дашборду

Debian 12, 2 ядра, 2 ГБ пам'яті, 20 ГБ диска, статична IP-адреса.

## 2. На сервері Asterisk: AMI-користувач

Створіть `/etc/asterisk/manager.d/dashboard.conf` за зразком `deploy/manager-dashboard.conf`
(пароль — `openssl rand -hex 24`, у `permit` — `IP_ДАШБОРДУ`), потім:

```bash
asterisk -rx "manager reload"
asterisk -rx "manager show user dashboard"
```

`manager reload` дзвінки і чужі AMI-підключення не зачіпає.

## 3. На сервері Asterisk: користувач MySQL лише для читання

Відредагуйте `deploy/mysql-user.sql` (`IP_ДАШБОРДУ`, пароль) і виконайте:

```bash
mysql --defaults-file=/etc/mysql/debian.cnf < mysql-user.sql
```

## 4. На віртуалці дашборду: встановлення з GitHub

```bash
apt update && apt install -y nodejs npm git curl default-mysql-client
useradd --system --home /opt/queue-dashboard --shell /usr/sbin/nologin queuedash
git clone https://github.com/sleepwalker108/asterisk_dashbord.git /opt/queue-dashboard
cd /opt/queue-dashboard
npm ci --omit=dev
cp config.example.json config.json
```

## 5. Налаштування `config.json` (на віртуалці дашборду)

- `ami.host`, `db.host` — `IP_ASTERISK`;
- `ami.secret` — пароль AMI з кроку 2 (звичайний пароль, не хеш);
- `db.password` — пароль MySQL з кроку 3;
- `users.operator.password`, `users.admin.password` — **хеш**, який видає `npm run hash-password`
  (рядок `scrypt$...`). Сам пароль у файл не пишеться.

Перевірка, що файл не зламаний:

```bash
node -e "JSON.parse(require('fs').readFileSync('/opt/queue-dashboard/config.json','utf8')); console.log('config OK')"
```

## 6. Запуск як сервіс (на віртуалці дашборду)

```bash
cd /opt/queue-dashboard
mkdir -p data
chown -R queuedash:queuedash /opt/queue-dashboard
chmod 640 config.json && chmod 750 data
cp deploy/queue-dashboard.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now queue-dashboard
curl -s http://127.0.0.1:8080/healthz     # {"ami":true,"db":true}
journalctl -u queue-dashboard -f          # журнал
```

Адреса в браузері: `http://IP_ДАШБОРДУ:8080`.

## 7. Оновлення з GitHub

```bash
bash /opt/queue-dashboard/deploy/update.sh
```

Скрипт забирає останню версію, ставить залежності й перезапускає сервіс. `config.json` і `data/` не чіпає.

### Перехід на оновлення з GitHub (якщо дашборд ставили з архіву)

Один раз, на віртуалці дашборду:

```bash
apt install -y git
git config --global --add safe.directory /opt/queue-dashboard
cd /opt/queue-dashboard
git init -q && git remote add origin https://github.com/sleepwalker108/asterisk_dashbord.git
git fetch -q origin && git reset --hard origin/main && git branch -M main && git branch -u origin/main
bash deploy/update.sh
```

`git reset --hard` замінює лише файли проєкту; `config.json`, `data/` і `node_modules/` лишаються.

---

## Телевізори

Відкрийте на телевізорі (браузер ТВ, Android-приставка, міні-ПК) одну з адрес:

| Що показувати | Адреса |
|---|---|
| Всі лінії | `http://IP_ДАШБОРДУ:8080/?tv=1` |
| Лише лінія 1648 | `http://IP_ДАШБОРДУ:8080/?tv=1&view=NIB` |
| Лише лінія 1548 | `http://IP_ДАШБОРДУ:8080/?tv=1&view=minre` |
| Лише Уповноважений | `http://IP_ДАШБОРДУ:8080/?tv=1&view=upov` |
| + панель «Дзвінки» (IVR і розмови) | додайте `&calls=1` |
| Світла тема | додайте `&theme=light` |

У режимі ТВ:
- усе масштабується під екран (Full HD, 4K) і вміщується без прокрутки;
- немає кнопок, вкладок і керування — навіть під логіном `admin`;
- курсор ховається через 3 секунди, вихід — кнопка «Вийти з режиму ТВ» (з'являється при русі мишки) або `Esc`;
- вхід під `operator` зберігається на 180 днів, після перезапуску ТВ логінитись знову не треба;
- при обриві зв'язку сторінка сама перепідключається.

Те саме відкривається кнопкою «📺 Режим ТВ» у шапці звичайного дашборду.
Вимкніть на телевізорі сплячий режим / заставку, щоб екран не гас.

---

## 8. Фаєрвол (рекомендовано)

На сервері Asterisk порти 5038 і 3306 варто відкрити лише для тих машин, яким вони потрібні
(дашборд, MonAst тощо). Робіть це обережно, щоб не відрізати інші системи.

## 9. Перевірка цифр

Перші дні дашборд працює паралельно з MonAst — звіряйте цифри. Розкладку дзвінків по категоріях можна
перевірити на сервері Asterisk:

```bash
mysql --defaults-file=/etc/mysql/debian.cnf < check-cdr.sql
```

## Що де лежить

| Файл | Що це |
|---|---|
| `config.json` | налаштування і паролі (не в git) |
| `data/sessions.json` | активні входи (лише хеші) |
| `dayStartHour` у `config.json` | година, з якої починається «доба» статистики (за замовчуванням 8: 08:00–08:00) |
| `data/alerts.json` | журнал тривог: початок і кінець |
| `data/audit.log` | хто з адмінів і коли ставив на паузу, додавав, видаляв |

## Перевірка без Asterisk

`node tools/fake-ami.js 15038`, а в `config.json`: `ami.host = 127.0.0.1`, `ami.port = 15038`, `db.enabled = false`.
