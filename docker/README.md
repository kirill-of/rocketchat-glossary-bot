Для локального запуска и отладки использовались:

RocketChat - [7.10.5](https://github.com/RocketChat/Rocket.Chat/releases/tag/7.10.5)

*Внимание!* Для работы RocketChat требуется MongoDB 

Использовалась MongoDB 7.0.4 Community установленная локально (вне докера по адресу mongodb://localhost:27017/)

### Инструкция

**Запускаем Rocket.Chat**
```bash
docker-compose up -d
```

**Проверяем Rocket.Chat (в браузере)**
```
http://localhost:3000/
```