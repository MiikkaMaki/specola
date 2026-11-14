.PHONY: dev test build lint demo

dev:
	npm run dev

test:
	npm test

lint:
	npm run lint

build:
	npm run build

demo:
	npm test && npm run dev
