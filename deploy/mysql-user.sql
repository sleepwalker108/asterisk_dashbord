-- Користувач MySQL для дашборду: лише читання трьох таблиць.
-- Запуск на сервері Asterisk:
--   mysql --defaults-file=/etc/mysql/debian.cnf < mysql-user.sql
-- Перед запуском замініть IP_ВІРТУАЛКИ і ПАРОЛЬ.

CREATE USER 'dashboard_ro'@'IP_ВІРТУАЛКИ' IDENTIFIED BY 'ПАРОЛЬ';
GRANT SELECT ON queue_log.queue_log TO 'dashboard_ro'@'IP_ВІРТУАЛКИ';
GRANT SELECT ON cdr.cdr              TO 'dashboard_ro'@'IP_ВІРТУАЛКИ';
GRANT SELECT ON monitoring.alerts    TO 'dashboard_ro'@'IP_ВІРТУАЛКИ';
FLUSH PRIVILEGES;
