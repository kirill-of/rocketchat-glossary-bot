Для локального запуска и отладки использовались:

MongoDB - [4.4.28](https://github.com/mongodb/mongo/releases/tag/r4.4.28)\
_(т.к. MongoDB 5.0+ требует CPU с поддержкой AVX\
"MongoDB 5.0+ requires a CPU with AVX support, and your current system does not appear to have that!")_

RocketChat - [4.5.0](https://github.com/RocketChat/Rocket.Chat/releases/tag/4.5.0)\
_(т.к. поддерживает MongoDB 4.4 и standalone)_

### Инструкция

**Запускаем MongoDB**

```bash
docker-compose up -d mongodb
```

**Ждем 15 секунд и инициализируем реплику командой mongo**
```bash
sleep 15
docker exec mongodb mongo --eval "rs.initiate()"
```

**Проверяем статус реплики**
```bash
docker exec mongodb mongo --eval "rs.status()"
```

**Проверяем что это primary**
```bash
docker exec mongodb mongo --eval "db.isMaster()"
```

**Запускаем Rocket.Chat**
```bash
docker-compose up -d
```

**Проверяем Rocket.Chat (в браузере)**
```
http://localhost:3000/
```

**Проверяем mongo-express (в браузере)**
```
http://localhost:8081/
```