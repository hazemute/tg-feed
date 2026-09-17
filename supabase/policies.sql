-- ============================================================================
-- TG-Feed — Row Level Security (RLS) для Supabase
-- ============================================================================
--
-- ЗАЧЕМ: приложение (Next.js на Vercel) подключается к Supabase через
-- direct/pooler-подключение (пользователь postgres / роль service_role —
-- владелец таблиц с BYPASSRLS), поэтому RLS для него ПРОЗРАЧЕН.
-- RLS защищает ДРУГОЙ сценарий: доступ к вашей базе через ПУБЛИЧНЫЙ
-- Supabase REST/Realtime API (anon key из фронтенда Supabase, авто-документация
-- на https://<PROJECT_REF>.supabase.co/rest/v1/...). Без RLS любой человек
-- с вашим anon key (он публичный) мог бы читать/писать любые таблицы.
--
-- СТРАТЕГИЯ: «всё закрыто» — включаем RLS на все 10 таблиц и НЕ создаём ни
-- одной политики. В PostgreSQL таблица с включённым RLS и без политик
-- ЗАПРЕЩАЕТ все операции для ролей, к которым RLS применяется (anon,
-- authenticated). Это безопасный дефолт: весь трафик идёт только через
-- наш API на Vercel.
--
-- ЕСЛИ захотите отдавать каталог (категории/активные каналы/посты) напрямую
-- из Supabase — раскомментируйте примеры read-only политик ВНИЗУ файла
-- (только SELECT, только для роли anon, только безопасные подмножества).
-- ============================================================================
--
-- ПОРЯДОК ПРИМЕНЕНИЯ: выполняется ВТОРЫМ, сразу после schema.sql.
-- Файл идемпотентен — можно запускать повторно.
-- ============================================================================

ALTER TABLE "User"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Category"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Channel"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Post"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Like"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PostView"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Subscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Bookmark"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Ad"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HashtagClick" ENABLE ROW LEVEL SECURITY;

-- Проверка: все 10 таблиц должны иметь rls_enabled = true
-- SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname = 'public'
--     AND tablename IN ('User','Category','Channel','Post','Like','PostView',
--                       'Subscription','Bookmark','Ad','HashtagClick')
--   ORDER BY tablename;

-- ============================================================================
-- ПРИМЕРЫ read-only политик для anon (ЗАКОММЕНТИРОВАНЫ — включайте осознанно)
-- ============================================================================
-- Открывают ТОЛЬКО чтение публичного каталога через Supabase REST API.
-- Пользовательские данные (User, Like, PostView, Subscription, Bookmark,
-- HashtagClick) и рекламные записи НЕ открываем — они остаются приватными.
--
-- 1) Категории — читаются целиком:
--
-- CREATE POLICY "anon_read_categories"
--     ON "Category"
--     FOR SELECT
--     TO anon
--     USING (true);
--
-- 2) Активные каналы — только со статусом 'active':
--
-- CREATE POLICY "anon_read_active_channels"
--     ON "Channel"
--     FOR SELECT
--     TO anon
--     USING ("status" = 'active');
--
-- 3) Посты — только посты активных каналов (through-subquery):
--
-- CREATE POLICY "anon_read_posts_of_active_channels"
--     ON "Post"
--     FOR SELECT
--     TO anon
--     USING (
--         EXISTS (
--             SELECT 1
--             FROM "Channel" c
--             WHERE c."id" = "Post"."channelId"
--               AND c."status" = 'active'
--         )
--     );
--
-- ПРИМЕЧАНИЕ: anon-роли также нужны GRANT-ы на схему/таблицы. В Supabase они
-- обычно уже выданы дефолтными привилегиями; если нет — раскомментируйте:
--
-- GRANT USAGE ON SCHEMA public TO anon;
-- GRANT SELECT ON "Category", "Channel", "Post" TO anon;
--
-- Откат (убрать публичный доступ снова):
-- DROP POLICY IF EXISTS "anon_read_categories" ON "Category";
-- DROP POLICY IF EXISTS "anon_read_active_channels" ON "Channel";
-- DROP POLICY IF EXISTS "anon_read_posts_of_active_channels" ON "Post";
-- REVOKE SELECT ON "Category", "Channel", "Post" FROM anon;
