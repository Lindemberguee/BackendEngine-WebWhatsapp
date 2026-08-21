# Deploy em VM Ubuntu

O `Dockerfile` depende dos workspaces `Backend` e `Engine`. Execute os comandos
na raiz do repositório, nunca dentro de `Backend` como contexto isolado.

## 1. Configuração

Instale Docker Engine e o plugin Docker Compose, clone o repositório e crie o
arquivo de ambiente:

```bash
cd /opt/webwhatsapp
cp Backend/.env.example Backend/.env
chmod 600 Backend/.env
```

Preencha pelo menos estas variáveis em `Backend/.env`:

- `MONGO_ROOT_USERNAME` e `MONGO_ROOT_PASSWORD`;
- `MONGO_APP_USERNAME` e `MONGO_APP_PASSWORD`;
- `JWT_SECRET`;
- `CREDENTIALS_ENCRYPTION_KEY`;
- `CORS_ORIGIN=https://app.seudominio.com`;
- `PUBLIC_API_URL=https://api.seudominio.com`;
- `PLATFORM_ADMIN_API_KEY`, se o backoffice for utilizado.

Use senhas hexadecimais aleatórias para o MongoDB, evitando caracteres que
precisem de codificação na URI:

```bash
openssl rand -hex 32
```

`JWT_SECRET`, `CREDENTIALS_ENCRYPTION_KEY` e `PLATFORM_ADMIN_API_KEY` devem ser
segredos diferentes. Não copie o mesmo valor entre eles.

## 2. Build e inicialização

```bash
cd /opt/webwhatsapp
docker compose -f Backend/docker-compose.yml config --quiet
docker compose -f Backend/docker-compose.yml build --pull backend
docker compose -f Backend/docker-compose.yml up -d mongodb backend
docker compose -f Backend/docker-compose.yml ps
curl --fail http://127.0.0.1:3333/health
```

O MongoDB, a API e o mongo-express ficam vinculados apenas a `127.0.0.1`.
Publique a API por Nginx ou Caddy com HTTPS e encaminhamento para
`http://127.0.0.1:3333`. No firewall da VM, exponha somente SSH, HTTP e HTTPS.

Para desenvolvimento, o mongo-express é opcional:

```bash
docker compose -f Backend/docker-compose.yml --profile dev up -d mongo-express
```

## 3. Persistência e atualização

As sessões Baileys ficam no MongoDB. Mídia local fica no volume `media_data`.
Em produção, prefira `MEDIA_STORAGE_DRIVER=s3` com R2/S3; caso continue usando
armazenamento local, inclua também `media_data` na rotina de backup.

Atualização normal:

```bash
git pull --ff-only
docker compose -f Backend/docker-compose.yml build --pull backend
docker compose -f Backend/docker-compose.yml up -d --remove-orphans
docker compose -f Backend/docker-compose.yml ps
```

O Compose concede 45 segundos para o backend parar agendadores e sessões antes
de encerrar o contêiner.

## 4. Banco existente

O script `scripts/mongo-init.js` cria o usuário da aplicação somente quando o
volume `mongo_data` é inicializado pela primeira vez. Se um volume antigo já
existir, crie manualmente o usuário `MONGO_APP_USERNAME` no banco
`webwhatsapp`, com a função `readWrite`, antes de ativar a nova URI autenticada.
Não remova um volume existente para forçar a inicialização: isso apagaria o
banco.

## 5. Backup

Instale MongoDB Database Tools no host e forneça `MONGODB_URI` ao cron por um
arquivo de ambiente protegido, sem colocar a senha diretamente na linha de
comando ou no crontab. O script gera arquivo compactado, checksum e aplica
permissões privadas:

```bash
/opt/webwhatsapp/Backend/scripts/backup-mongo.sh
```

Copie os backups para outro servidor ou object storage e teste periodicamente o
procedimento de restauração. Um backup mantido apenas na mesma VM não protege
contra perda do disco ou comprometimento do host.
