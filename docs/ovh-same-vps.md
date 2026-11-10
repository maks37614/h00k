# Community і персональні профілі поруч із h00k.top на OVHcloud

Ця інструкція готує **закритий пілот на тому самому VPS**: чинний h00k.top працює своїм процесом, додаються лише Community та PostgreSQL. Community має окремий інтерфейс і не запускає скрінер. Нові тестові акаунти не об'єднуються з Firebase-акаунтами чинного сайта.

Припущення: Ubuntu 24.04 x86_64, Docker Compose вже працює, Nginx установлено на хості. Якщо використовується Caddy, Traefik, Nginx у контейнері, ARM або інша схема, спочатку звірте порти/мережі з нею. Не копіюйте конфігурацію іншого проксі поверх чинної.

## Навантаження

Піддомен — адреса, а не новий запущений застосунок. Тисяча зарезервованих імен без відвідувань не створює тисячу процесів чи біржових підключень. Ресурси витрачаються на фактичні HTTP-запити, PostgreSQL, фото та відкриті графіки. TLS та передавання JS/CSS теж мають звичайну вартість.

Профілі використовують окрему збірку: у ній немає App, провайдерів скрінера чи його біржового fallback. Стрічка показує SVG-прев'ю; повний HookChart і збережений документ завантажуються тільки після натискання. Публічний редактор працює локально зі знімком, без довантаження історії з бірж. Сам сервіс профілів не викликає біржових API. Динамічні відповіді не кешуються між користувачами, щоб нові запити враховували поточну приватність; статичні assets мають хеші й можуть кешуватися.

Compose нижче обмежує Community до 0,75 CPU / 1 ГБ RAM, PostgreSQL — до 0,5 CPU / 1 ГБ RAM. Це стартові межі для малого пілота, а не перевірена місткість. Вони не гарантують незмінну швидкість скрінера: диск, мережа, ядро ОС і фізичний CPU спільні. Перед запуском бажано мати приблизно 3 ГБ доступної RAM і запас CPU/SSD. Якщо ресурсів немає, спочатку визначте реальний запас, а не запускайте стек навмання. Біржовий вихід Community залишається вимкненим.

## 1. Перевірка чинного VPS без змін

Виконайте через SSH:

```bash
cat /etc/os-release
uname -m
nproc
free -h
df -h /
sudo docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
sudo docker compose ls
sudo ss -lntp
ip route
```

Окремо перевірте імена Nginx:

```bash
sudo nginx -t
sudo nginx -T 2>/dev/null | sed -n '/^[[:space:]]*server_name[[:space:]]/p'
sudo docker network ls
```

Переконайтеся, що порт **3101** вільний і мережа **172.30.89.0/24** не використовується на VPS, у VPN чи Docker. Для іншої мережі узгоджено змініть `subnet`, `gateway` і `COMMUNITY_TRUST_PROXY` в Compose. Перевірте, які саме vhost обслуговують `h00k.top`, `www`, пошту та інші наявні піддомени. Якщо вже є `*.h00k.top` або `.h00k.top`, узгодьте маршрути перед додаванням нового wildcard: дублювати їх не можна.

Збережіть чинну конфігурацію Nginx, Compose, секрети й узгоджений backup тому даних h00k.top. OVH-сnapshot може бути додатковою копією VPS, але він не замінює окремий експорт зовнішніх Firebase-даних. Наведений нижче пілот не читає й не змінює старі production-томи.

Не перевстановлюйте Docker/Nginx на працюючому сервері та не змінюйте firewall навмання. Нових публічних портів для цього стека не потрібно: використовується чинний HTTPS, порт Community публікується тільки на loopback, PostgreSQL не публікується.

## 2. Збірка без навантаження на production

На окремому комп'ютері з Docker — Linux, macOS або WSL2 — виконайте:

```bash
git clone --branch codex/community-chart-workspace --single-branch https://github.com/maks37614/h00k.git h00k-community-source
cd h00k-community-source
git log -1 --oneline
H00K_COMMUNITY_RELEASE="$(git rev-parse --short=12 HEAD)"
git rev-parse HEAD > ../h00k-community-source.sha
docker buildx build --platform linux/amd64 --load -t "h00k-community:$H00K_COMMUNITY_RELEASE" .
docker image save -o ../h00k-community-image.tar "h00k-community:$H00K_COMMUNITY_RELEASE"
tar -czf ../h00k-community-deploy.tar.gz deploy docs/ovh-same-vps.md
```

Рев'ю та перевірки мають стосуватися вибраного коміту. Збережений SHA фіксує його; не використовуйте наступний коміт гілки автоматично. Образ містить схему та обидва окремі інтерфейси. Нові залежності, Node і npm на VPS установлювати не потрібно.

На VPS створіть нову директорію поза робочою директорією h00k.top:

```bash
mkdir -p "$HOME/h00k-community-sidecar"
```

Із комп'ютера збірки передайте файли, замінивши `USER`, `VPS_IP` і SSH-порт:

```bash
scp -P 22 ../h00k-community-image.tar ../h00k-community-deploy.tar.gz ../h00k-community-source.sha USER@VPS_IP:~/h00k-community-sidecar/
```

На VPS:

```bash
cd "$HOME/h00k-community-sidecar"
sudo docker image load -i h00k-community-image.tar
tar -xzf h00k-community-deploy.tar.gz
cut -c1-12 h00k-community-source.sha
```

Остання команда покаже мітку для образу `h00k-community:МІТКА`. Якщо окремої машини збірки немає, збірку на VPS плануйте на час низького навантаження після перевірки RAM/CPU. Ліміти працюючих сервісів Compose не обмежують Docker build; `nice` для клієнта Docker теж не резервує ресурси production.

## 3. Конфігурація Community

Створіть `.env.community` один раз. Команда не друкує секретів і не перезаписує наявний файл:

```bash
umask 077
python3 - <<'PY'
from pathlib import Path
import secrets
import base64

sha = Path('h00k-community-source.sha').read_text().strip()
if len(sha) != 40 or any(c not in '0123456789abcdef' for c in sha):
    raise SystemExit('Перевірте source.sha')
values = f"""H00K_COMMUNITY_IMAGE=h00k-community:{sha[:12]}
APP_ORIGIN=https://community-stage.h00k.top
COMMUNITY_PROFILE_DOMAIN=
COMMUNITY_DB_PASSWORD={secrets.token_hex(32)}
COMMUNITY_ENCRYPTION_KEY={base64.b64encode(secrets.token_bytes(32)).decode('ascii')}
SMTP_URL='smtps://USER:URL_ENCODED_PASSWORD@smtp.example.com:465'
MAIL_FROM='h00k Community <noreply@h00k.top>'
COMMUNITY_MODERATOR_IDS=
"""
with Path('.env.community').open('x', encoding='utf-8') as output:
    output.write(values)
Path('.env.community').chmod(0o600)
print('Створено .env.community. Налаштуйте реальний SMTP_URL і MAIL_FROM.')
PY
nano .env.community
```

SMTP-пароль у URL має бути percent-encoded. Використайте адресу/порт і відправника свого поштового провайдера, налаштуйте SPF/DKIM. Без справжньої доставки пошти не перевірити реєстрацію та відновлення доступу.

`COMMUNITY_ENCRYPTION_KEY` — постійний ключ шифрування MFA й біржових секретів. Збережіть його в захищеній копії. Не генеруйте новий при оновленні. `.env.community` не має потрапляти в Git, Docker build context, issue або чат.

Поки `COMMUNITY_PROFILE_DOMAIN` порожній, сторінки доступні за адресою `https://community-stage.h00k.top/u/ivan`. Це дозволяє перевірити їх до ввімкнення wildcard-маршруту.

## 4. PostgreSQL та окремий процес Community

Визначте функцію в Bash у поточній SSH-сесії:

```bash
cd "$HOME/h00k-community-sidecar"
dc() {
  sudo docker compose --project-name h00k-community-stage --env-file .env.community -f deploy/compose.community-sidecar.yaml "$@"
}
dc config --quiet
dc up -d postgres
dc ps
dc run --rm --no-deps --user 0 --entrypoint sh community -c 'chown 1000:1000 /app/community-media && chmod 700 /app/community-media'
dc run --rm community npm run community:migrate
```

Міграція має завершитися з кодом 0. Вона застосовує схему PostgreSQL, включно з іменами профілів, але **не імпортує Firebase-користувачів**. Схема не застосовується автоматично при старті API.

Потім:

```bash
dc up -d community
dc ps
curl --fail http://127.0.0.1:3101/api/community-health
dc exec -T postgres psql -U h00k_community -d h00k_community_stage -c "SELECT to_regclass('public.hc_users'),to_regclass('public.hc_profile_names'),to_regclass('public.hc_charts');"
dc logs --tail=60 community postgres
```

Перевірте назви всіх трьох таблиць. HTTP health перевіряє лише процес. Перегляд логів не замінює тестування пошти й роботи БД. Томи матимуть назви `h00k-community-stage_postgres_data` та `h00k-community-stage_community_media`; старий `h00k_app_data` тут не використовується.

Не запускайте в цьому проєкті `server.ts`, сервіс `app` або основний `compose.yaml`. Community-only UI вже обслуговує `communityServer.ts`.

## 5. DNS в OVHcloud

VPS у OVHcloud не означає, що DNS домену теж керується там. Перевірте авторитетні NS у панелі домену. Якщо вони належать іншому провайдеру, записи та DNS-01 налаштовуються саме в нього; NS чинного домену для цього переносити не потрібно.

Якщо DNS у OVHcloud: **Web Cloud → Noms de domaine / Domain names → h00k.top → Zone DNS / Strefa DNS → Add an entry / Dodaj wpis**.

| Тип | Піддомен | Значення | Коли додавати |
| --- | --- | --- | --- |
| A | `community-stage` | IPv4 чинного VPS | Для тестового Community |
| A | `*` | Та сама IPv4 | Після перевірки наявних піддоменів і Nginx |

У поле піддомену вводиться лише `community-stage` або `*`. Не змінюйте кореневий A/AAAA, MX, DKIM, SPF, NS і чинні службові записи. Якщо wildcard уже є, спочатку звірте його призначення. AAAA додавайте лише з перевіреним IPv6 цього VPS. Використовуйте DNS-only для цих нових адрес; додатковий CDN-проксі потребує окремого налаштування перевірених адрес та IP-клієнта.

## 6. HTTPS wildcard через DNS-01

Окремий сертифікат `*.h00k.top` покриває `ivan.h00k.top` і `community-stage.h00k.top`. Кореневий `h00k.top` цим шаблоном не покривається; його чинний сертифікат залишаємо в його vhost. Сертифікат для Community отримає окреме ім'я `h00k-community-wildcard`.

Спочатку визначте спосіб поточної установки Certbot. Не встановлюйте паралельно apt- і snap-версії:

```bash
command -v certbot
certbot --version
```

Для наявного apt-Certbot в Ubuntu доступний плагін:

```bash
sudo apt-get install python3-certbot-dns-ovh
sudo certbot plugins
```

Для наявного snap-Certbot використайте його спосіб:

```bash
sudo snap set certbot trust-plugin-with-root=ok
sudo snap install certbot-dns-ovh
sudo /snap/bin/certbot plugins
```

Якщо Certbot відсутній або встановлений через pip, застосуйте відповідний офіційний спосіб і DNS-плагін для нього. Подальші приклади використовують `certbot`; для snap, якщо немає такого посилання в PATH, використовуйте `/snap/bin/certbot`.

Створіть **окремі OVH API credentials** тільки для DNS-зони `h00k.top` за посиланням OVH Europe з документації плагіна: [certbot-dns-ovh](https://certbot-dns-ovh.readthedocs.io/en/stable/). Документовані правила для однієї зони:

```text
GET /domain/zone/
GET /domain/zone/h00k.top/*
PUT /domain/zone/h00k.top/*
POST /domain/zone/h00k.top/*
DELETE /domain/zone/h00k.top/*
```

Ці credentials мають доступ до записів цієї зони, тому зберігайте їх як пароль, окремо від процесу Community. Не використовуйте загальний ключ повного адміністратора OVH. Для довготривалого використання сплануйте строк дії та ротацію, щоб продовження сертифіката не зупинилося через прострочення ключа.

```bash
sudo install -d -m 0700 /root/.secrets/certbot
sudo nano /root/.secrets/certbot/ovh-h00k.ini
```

Вміст файла:

```ini
dns_ovh_endpoint = ovh-eu
dns_ovh_application_key = ВАШ_APPLICATION_KEY
dns_ovh_application_secret = ВАШ_APPLICATION_SECRET
dns_ovh_consumer_key = ВАШ_CONSUMER_KEY
```

```bash
sudo chmod 0600 /root/.secrets/certbot/ovh-h00k.ini
sudo certbot certonly --dns-ovh --dns-ovh-credentials /root/.secrets/certbot/ovh-h00k.ini --dns-ovh-propagation-seconds 120 --cert-name h00k-community-wildcard -d '*.h00k.top'
```

DNS-01 не потребує зупинки чинного Nginx або звільнення порту 80. Certbot створює/видаляє перевірочний TXT через API. Якщо DNS у іншого провайдера, цей плагін не підійде: використовуйте його DNS-плагін. Саме розміщення VPS в OVH не дає OVH контролю над чужою DNS-зоною.

Налаштуйте продовження через наявний Certbot timer і перевірте `sudo certbot renew --dry-run`. Після поновлення Nginx має перечитати сертифікат через deploy-hook; використайте чинний, а якщо його немає, створіть окремий:

```bash
sudo install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/h00k-community-nginx >/dev/null <<'SH'
#!/bin/sh
set -eu
nginx -t
systemctl reload nginx
SH
sudo chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/h00k-community-nginx
```

Не додавайте дублюючий cron, якщо автоматичне продовження вже налаштоване. Якщо були сторонні production-сертифікати, звірте результати dry-run для кожного.

## 7. Окремі vhost Nginx

Готові приклади знаходяться в `deploy/nginx/`. Вони додаються поруч із чинним h00k.top. Команди нижче призначені для **нових, ще не зайнятих** файлів з цими іменами. Спочатку перевірте, що таких файлів немає; за наявності не перезаписуйте їх без порівняння.

Спочатку відредагуйте список доступу:

```bash
nano deploy/nginx/community-allowlist.conf.example
```

Замініть `203.0.113.10` на вашу зовнішню IP. Для інших тестувальників додайте окремі `allow`. Це закритий пілот; правило `deny all` поки залишається і на персональних профілях.

Установіть спільні параметри та точний vhost тестового Community:

```bash
sudo install -m 0644 deploy/nginx/community-http.conf.example /etc/nginx/conf.d/h00k-community-http.conf
sudo install -m 0644 deploy/nginx/community-proxy.conf.example /etc/nginx/snippets/h00k-community-proxy.conf
sudo install -m 0644 deploy/nginx/community-allowlist.conf.example /etc/nginx/snippets/h00k-community-allowlist.conf
sudo install -m 0644 deploy/nginx/community-site.conf.example /etc/nginx/sites-available/h00k-community-stage
sudo ln -s /etc/nginx/sites-available/h00k-community-stage /etc/nginx/sites-enabled/h00k-community-stage
sudo nginx -t
sudo systemctl reload nginx
```

Якщо `nginx -t` повідомляє про помилку чи конфлікт імен, не перезавантажуйте конфігурацію. Усуньте помилку або приберіть лише новий невдалий vhost; чинні файли h00k.top не видаляйте.

Перевірте локально з правильним HTTPS-host:

```bash
curl --fail --resolve community-stage.h00k.top:443:127.0.0.1 https://community-stage.h00k.top/api/community-health
curl --fail --resolve community-stage.h00k.top:443:127.0.0.1 https://community-stage.h00k.top/
```

Відкрийте `https://community-stage.h00k.top` зі своєї дозволеної IP. Це окремий Community-only UI: він не підключає App/скрінер, Alerts/Surveillance-провайдери або прямий біржовий fallback. На цій стадії не змінюються Nginx-маршрути чи процес чинного h00k.top.

## 8. Перевірка профілю до wildcard

1. Зареєструйте тестовий native-акаунт. Перевірте доставку листа, підтвердження email та вхід.
2. У «Мій профіль» знайдіть «Персональна адреса h00k». Зарезервуйте, наприклад, `ivan`, підтвердивши пароль та налаштований другий фактор.
3. Залиште фінансові дані приватними. Увімкніть «Дозволити перегляд публічного профілю без входу» тільки для тестового акаунта. Це окрема явна згода на публічний веб-доступ.
4. Відкрийте `https://community-stage.h00k.top/u/ivan`. Перевірте його без сеансу, з іншого акаунта і після вимкнення видимості. За вимкнення/видалення нові запити повертають недоступність.
5. Перевірте публічний, друзям і приватний пости; фото й копії графіків; зміну доступу до джерела. Відкриття повного HookChart має завантажувати лише збережений документ. Доступні знімкові таймфрейми/агрегація, а не біржова історія.
6. Якщо тестуєте статистику, відкрийте її окремим налаштуванням; суми мають окремий дозвіл. Сторінка не публікує баланс, рядки угод чи приватні нотатки. Поточна API-статистика стосується імпортованих Bybit linear closed orders, з позначенням покриття та останньої синхронізації.

У цій порожній тестовій БД немає старих формацій, watchlist та користувачів. Їхню міграцію не підміняє нова реєстрація. Повний Replay відкривається у чинному скрінері за дією користувача; інтеграція з його старими акаунтами ще потребує міграції.

## 9. Увімкнення персональних адрес

Після перевірки піддоменів у кроці 1 додайте wildcard A-запис з кроку 5 і окремий wildcard vhost:

```bash
sudo install -m 0644 deploy/nginx/profile-wildcard.conf.example /etc/nginx/sites-available/h00k-profile-wildcard
sudo ln -s /etc/nginx/sites-available/h00k-profile-wildcard /etc/nginx/sites-enabled/h00k-profile-wildcard
sudo nginx -t
sudo systemctl reload nginx
nano .env.community
```

Установіть `COMMUNITY_PROFILE_DOMAIN=h00k.top`, зберігши всі попередні ключі, пароль БД та образ. Застосуйте змінене оточення:

```bash
dc up -d community
```

Перевірте:

```bash
curl --fail --resolve ivan.h00k.top:443:127.0.0.1 https://ivan.h00k.top/api/public/profiles/ivan
curl --fail --resolve ivan.h00k.top:443:127.0.0.1 https://ivan.h00k.top/
```

На персональних адресах сервер дозволяє лише публічне читання. Nginx не передає їм Cookie/Authorization; приватні API та зміни там недоступні. Кнопка «Відкрити у Community» веде на налаштований `APP_ORIGIN`, у пілоті — `community-stage.h00k.top`, де залишається вхід і сеанс.

Зміна username можлива раз на 30 днів. Попередня адреса відразу перестає працювати, автоматично не перенаправляється і не передається іншому користувачу. Після зміни/видалення залишається тільки відокремлений від власника digest для заборони повторного призначення; це окрема політика захисту адрес. Кеші та вже завантажені чужі копії не можна вважати відкликаними заднім числом.

## 10. Контроль ресурсів і резервні копії

Порівняйте до/після запуску: CPU/RAM/диск, час API скрінера, плавність графіків, число біржових підключень. Можна використовувати:

```bash
sudo docker stats --no-stream
dc logs --tail=80 community postgres
free -h
df -h /
```

Зберігайте backup PostgreSQL, тому фото, образу/коміту, Compose, Nginx та `.env.community` разом із ключем шифрування. Для узгодженої файлової копії закритого стенда коротко зупиніть тільки Community; PostgreSQL і чинний скрінер залишаються запущеними:

```bash
(
  set -euo pipefail
  umask 077
  backup_dir="$PWD/backups/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$backup_dir"
  community_image_id="$(sudo docker inspect --format '{{.Image}}' "$(dc ps -q community)")"
  trap 'dc start community' EXIT
  dc stop -t 40 community
  dc exec -T postgres pg_dump -U h00k_community -d h00k_community_stage -Fc > "$backup_dir/community.dump"
  sudo docker run --rm --network none --read-only --user 1000:1000 --mount type=volume,src=h00k-community-stage_community_media,target=/data,readonly --entrypoint tar "$community_image_id" -C /data -czf - . > "$backup_dir/community-media.tar.gz"
  cp -p .env.community "$backup_dir/env.community"
  cp -r deploy "$backup_dir/deploy"
  cp h00k-community-source.sha "$backup_dir/source.sha"
  dc exec -T postgres pg_restore --list < "$backup_dir/community.dump" > "$backup_dir/database-contents.txt"
  tar -tzf "$backup_dir/community-media.tar.gz" >/dev/null
  printf 'Backup: %s\n' "$backup_dir"
)
```

Налаштування фактично встановленого Nginx з вашими подальшими правками, Certbot/DNS credentials і серверні секрети також мають окрему захищену копію. Копії шифруйте і зберігайте поза VPS; перевірте відновлення на ізольованій БД. Перед публічним запуском потрібна політика retention та повторення видалень після відновлення давньої копії.

Для зупинки доданого стенда достатньо `dc stop`. Не виконуйте `down -v`, `docker volume prune`, не видаляйте `h00k_app_data` та не зупиняйте всі контейнери сервера. Якщо Nginx після додавання vhost не працює, повертайте лише нові файли/посилання до збереженої версії, потім `nginx -t` і reload.

## 11. Перехід від пілота до спільних production-акаунтів

Цей крок ще не автоматизований. Перед ним потрібні довірений експорт Firebase, підтверджена карта старих ID → native UUID, фактичний імпортер, перенос власників alerts/Telegram/surveillance, перевірка backup/rollback та життєвого циклу даних. `community:migration-plan` — тільки аналізатор, без apply-режиму.

Після виконання цих умов можна оновити **єдиний чинний** app до перевіреної версії з native-авторизацією, дати йому приватний доступ до тієї самої PostgreSQL і Community, налаштувати прямі Nginx-маршрути Community API й assets. Пароль/роль runtime-БД варто відокремити від адміністратора міграцій. Потім змінюється канонічний `APP_ORIGIN` і сплановано переноситься вхід; не розширюйте Domain cookie на всі піддомени для обходу цього переходу.

Для відкритого запуску ще потрібні перевірки реального PostgreSQL, SMTP/retry, MFA/recovery, очищення даних і файлів, браузерів/мобільних екранів, модерації й спільного навантаження. Лише після них переглядається IP-allowlist. Вихід Community на біржі залишається вимкненим до окремого egress або узгодженого IP-бюджету всіх споживачів, включно з чинним скрінером.

## Джерела та перевірка

- [OVHcloud: DNS FAQ і wildcard](https://docs.ovhcloud.com/en/guides/web-cloud/domains/faq-domain-dns).
- [OVHcloud: редагування DNS-зони](https://docs.ovhcloud.com/en/guides/web-cloud/domains/dns-zone-edit).
- [Certbot DNS OVH: credentials та аргументи](https://certbot-dns-ovh.readthedocs.io/en/stable/).
- [Let's Encrypt: DNS-01](https://letsencrypt.org/docs/challenge-types/).
- [Nginx: пріоритет імен vhost](https://nginx.org/en/docs/http/server_names.html).
- [Docker: Compose](https://docs.docker.com/reference/cli/docker/compose/).

Приклади призначені для перевірки на вашій фактичній конфігурації. Синтаксис YAML/Bash та код перевіряються локально; Docker, Nginx, DNS і сертифікати на вашому OVH VPS під час підготовки цієї зміни не налаштовувалися. Поточна гілка залишається draft; пілот не є заявою про повну готовність усієї Community.
