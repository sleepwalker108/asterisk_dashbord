-- Перевірка, як дзвінки за сьогодні лягають у CDR (без номерів абонентів).
-- Запуск на сервері Asterisk:
--   mysql --defaults-file=/etc/mysql/debian.cnf < check-cdr.sql
-- Потрібно, щоб звірити «Кинули в IVR», «Під час тривоги» і переведення з Уповноваженого.

SELECT dcontext, lastapp,
       CASE WHEN lastdata LIKE '%alarm%' THEN 'alarm'
            WHEN lastdata LIKE '%no_answer%' THEN 'no_answer'
            WHEN lastapp = 'Queue' THEN 'queue'
            ELSE LEFT(lastdata, 30) END AS kind,
       disposition, COUNT(*) AS calls
  FROM cdr.cdr
 WHERE calldate >= CURDATE() AND channel LIKE 'SIP/transit1-%'
 GROUP BY dcontext, lastapp, kind, disposition
 ORDER BY calls DESC
 LIMIT 40;

SELECT LEFT(clid, LOCATE('"', clid, 2)) AS cid_name, dcontext, COUNT(*) AS calls
  FROM cdr.cdr
 WHERE calldate >= CURDATE() AND channel LIKE 'SIP/transit1-%'
 GROUP BY cid_name, dcontext
 ORDER BY calls DESC;
