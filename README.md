# ECOInter — Market Analyzer

Локальная платформа анализа рынка Eco. Исходники проекта подготовлены в архиве ECOInter-source.zip. Интеграция GoodPrice пока не подтверждена: соединение к http://188.235.146.195:3001/plugin/GoodPrice завершилось Connection refused, поэтому структура API не выдумывается.

## Запуск

Требуется Node.js 20+ и pnpm 9+.

```bash
pnpm install
pnpm dev
```

См. docs/goodprice-api.md и README полного исходного проекта для сведений о статусе, ограничениях и конфигурации.
