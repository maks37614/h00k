# h00k

Сайт https://h00k.top працює на VPS із Docker Compose. Збірка та запуск сервісу `app` налаштовані у `Dockerfile` і `compose.yaml`.

Локальні перевірки: `npm ci`, `npm run lint`, `npm test`, `npm run build`.

Пілот Community і персональні профілі поруч із чинним скрінером на OVH VPS: [docs/ovh-same-vps.md](docs/ovh-same-vps.md). Окремий стек запускає тільки Community та PostgreSQL, без другого market server. Перед production потрібні міграція ідентичностей і перевірки з [архітектури](docs/community-architecture.md).
