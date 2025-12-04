import {
	IAppAccessors,
	IHttp,
	ILogger,
	IModify,
	IPersistence,
	IRead,
} from '@rocket.chat/apps-engine/definition/accessors';
import { App } from '@rocket.chat/apps-engine/definition/App';
import { IAppInfo, RocketChatAssociationModel, RocketChatAssociationRecord } from '@rocket.chat/apps-engine/definition/metadata';
import { IMessage, IPostMessageSent } from '@rocket.chat/apps-engine/definition/messages';
import { IRoom } from '@rocket.chat/apps-engine/definition/rooms';
import { IUser } from '@rocket.chat/apps-engine/definition/users';

interface KeyValuePair {
	key: string;
	value: string;
}

interface GlossaryValue {
	value: string;
	createdAt: string;
	createdBy: string;
}

interface GlossaryEntry {
	values: GlossaryValue[];
}

interface AddValueResult {
	added: boolean;
	reason?: 'duplicate' | 'error';
}

type CommandType = 'add' | 'multi-add' | 'remove' | 'details' | 'help' | null;

export default class GlossaryBotApp extends App implements IPostMessageSent {
	private static readonly COMMAND_PREFIX = '!' as const;
	private static readonly ROOM_TYPE_DIRECT = 'd' as const;

	private static readonly COMMANDS = {
		ADD: 'add',
		MULTI_ADD: 'multi-add',
		REMOVE: 'remove',
		DETAILS: 'details',
		HELP: 'help',
	} as const;

	private static readonly MESSAGES = {
		INVALID_ADD_FORMAT: '❌ Неверный формат команды. Используйте: `!add <ключ>:<значение>`',
		INVALID_MULTI_ADD_FORMAT: '❌ Неверный формат команды. Используйте:\n`!multi-add\n<ключ1>:<значение1>;\n<ключ2>:<значение2>;`',
		INVALID_REMOVE_FORMAT:
			'❌ Неверный формат команды. Используйте:\n`!remove <ключ>` - удалить весь ключ\n`!remove <ключ>:<значение>` - удалить конкретное значение',
		INVALID_DETAILS_FORMAT: '❌ Неверный формат команды. Используйте: `!details <ключ>:<значение>`',
		INVALID_SEARCH_KEY: '❌ Ключ не должен быть пустым.',
		VALUE_ADDED: (key: string, value: string) => `✅ Значение успешно добавлено для ключа "*${key}*":\n${value}`,
		DUPLICATE_VALUE: (key: string) => `❌ Такое значение уже существует для ключа "*${key}*".`,
		SAVE_ERROR: '❌ Произошла ошибка при сохранении.',
		VALUE_REMOVED: (key: string, value: string) => `✅ Значение "*${value}*" успешно удалено для ключа "*${key}*"`,
		VALUE_NOT_FOUND: (key: string, value: string) => `❌ Значение "*${value}*" не найдено для ключа "*${key}*"`,
		KEY_REMOVED: (key: string) => `✅ Ключ "*${key}*" и все его значения успешно удалены`,
		KEY_NOT_FOUND: (key: string) => `❌ Ключ "*${key}*" не найден`,
		KEY_NOT_FOUND_SEARCH: (key: string) =>
			`Значение для ключа "*${key}*" не найдено.\n\nЧтобы добавить значение, используйте команду:\n\`!add ${key}: <ваше значение>\``,
	} as const;

	constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
		super(info, logger, accessors);
	}

	/**
	 * Нормализует ключ (приводит к нижнему регистру для регистронезависимого поиска)
	 */
	private normalizeKey(key: string): string {
		return key?.trim().toLowerCase() || '';
	}

	private isValidKey(key: string): boolean {
		return this.normalizeKey(key).length > 0;
	}

	private normalizeValue(value: string): string {
		return value?.trim().toLowerCase() || '';
	}

	private isValidValue(value: string): boolean {
		return this.normalizeValue(value).length > 0;
	}

	/**
	 * Возвращает e-mail пользователя
	 */
	private getUserEmail(user: IUser): string {
		const primaryEmail = user.emails?.find(email => email.verified) ?? user.emails?.[0];
		return primaryEmail?.address || user.username || user.name || 'unknown';
	}

	private formatDate(dateIso: string): string {
		if (!dateIso) {
			return 'неизвестно';
		}

		const date = new Date(dateIso);
		return isNaN(date.getTime()) ? dateIso : date.toLocaleString('ru-RU');
	}

	/**
	 * Возвращает ассоциацию для ключа
	 */
	private getAssociationForKey(key: string): RocketChatAssociationRecord {
		return new RocketChatAssociationRecord(
			RocketChatAssociationModel.MISC,
			this.normalizeKey(key)
		);
	}

	/**
	 * Возвращает запись глоссария для ключа
	 */
	private async getEntryForKey(
		read: IRead,
		key: string
	): Promise<GlossaryValue[] | null> {
		if (!this.isValidKey(key)) {
			return null;
		}

		try {
			const association = this.getAssociationForKey(key);
			const records = await read.getPersistenceReader().readByAssociation(association);

			if (!records || records.length === 0) {
				return null;
			}

			const [rawEntry] = records;
			const entry = rawEntry as GlossaryEntry;

			if (!entry?.values || !Array.isArray(entry.values) || entry.values.length === 0) {
				return null;
			}

			return entry.values;
		} catch (error) {
			this.getLogger().error('Ошибка при чтении из БД', error);
			return null;
		}
	}

	/**
	 * Возвращает все значения по ключу
	 */
	private async getValuesForKey(read: IRead, key: string): Promise<string[] | null> {
		const entry = await this.getEntryForKey(read, key);
		if (!entry) {
			return null;
		}

		return entry
			.map(item => item.value)
			.filter((value): value is string => Boolean(value));
	}

	/**
	 * Сохраняет список значений для ключа (полностью перезаписывает)
	 */
	private async saveValuesForKey(
		persistence: IPersistence,
		key: string,
		values: GlossaryValue[]
	): Promise<void> {
		if (!this.isValidKey(key)) {
			throw new Error('Cannot save values: invalid key');
		}

		const association = this.getAssociationForKey(key);
		await persistence.removeByAssociation(association);
		await persistence.createWithAssociation({ values }, association);
	}

	/**
	 * Добавляет значение к ключу
	 */
	private async addValueToKey(
		read: IRead,
		persistence: IPersistence,
		key: string,
		value: string,
		user: IUser
	): Promise<AddValueResult> {
		if (!this.isValidKey(key) || !this.isValidValue(value)) {
			return { added: false, reason: 'error' };
		}

		try {
			const normalizedValue = value.trim();
			const normalizedValueKey = this.normalizeValue(normalizedValue);
			const existingValues = (await this.getEntryForKey(read, key)) ?? [];
			const hasDuplicate = existingValues.some(item => this.normalizeValue(item.value) === normalizedValueKey);

			if (hasDuplicate) {
				return { added: false, reason: 'duplicate' };
			}

			const createdBy = this.getUserEmail(user);
			const newValues: GlossaryValue[] = [
				...existingValues,
				{
					value: normalizedValue,
					createdAt: new Date().toISOString(),
					createdBy,
				},
			];

			await this.saveValuesForKey(persistence, key, newValues);
			return { added: true };
		} catch (error) {
			this.getLogger().error('Ошибка при добавлении значения', { key, error });
			return { added: false, reason: 'error' };
		}
	}

	/**
	 * Удаляет ключ полностью
	 */
	private async removeKey(
		read: IRead,
		persistence: IPersistence,
		key: string
	): Promise<boolean> {
		if (!this.isValidKey(key)) {
			return false;
		}

		const entry = await this.getEntryForKey(read, key);
		if (!entry) {
			return false;
		}

		try {
			const association = this.getAssociationForKey(key);
			await persistence.removeByAssociation(association);
			this.getLogger().debug('Ключ удален из БД', { key: this.normalizeKey(key) });
			return true;
		} catch (error) {
			this.getLogger().error('Ошибка при удалении ключа', { key, error });
			return false;
		}
	}

	/**
	 * Удаляет конкретное значение для ключа
	 */
	private async removeValueForKey(
		read: IRead,
		persistence: IPersistence,
		key: string,
		value: string
	): Promise<boolean> {
		if (!this.isValidKey(key) || !this.isValidValue(value)) {
			return false;
		}

		const entry = await this.getEntryForKey(read, key);
		if (!entry || entry.length === 0) {
			return false;
		}

		const normalizedValue = this.normalizeValue(value);
		const filtered = entry.filter(item => {
			if (!item?.value) {
				return true;
			}
			return this.normalizeValue(item.value) !== normalizedValue;
		});

		if (filtered.length === entry.length) {
			return false;
		}

		try {
			if (filtered.length === 0) {
				const association = this.getAssociationForKey(key);
				await persistence.removeByAssociation(association);
			} else {
				await this.saveValuesForKey(persistence, key, filtered);
			}

			this.getLogger().debug('Значение удалено из БД', { key: this.normalizeKey(key), value });
			return true;
		} catch (error) {
			this.getLogger().error('Ошибка при удалении значения', { key, value, error });
			return false;
		}
	}

	/**
	 * Отправляет сообщение пользователю
	 */
	private async sendMessage(
		modify: IModify,
		room: IRoom,
		text: string
	): Promise<void> {
		if (!room || !text?.trim()) {
			this.getLogger().warn('Попытка отправить пустое сообщение или в несуществующую комнату');
			return;
		}

		try {
			const messageBuilder = modify.getCreator().startMessage();
			messageBuilder.setRoom(room);
			messageBuilder.setText(text);
			await modify.getCreator().finish(messageBuilder);
		} catch (error) {
			this.getLogger().error('Ошибка при отправке сообщения', error);
		}
	}

	/**
	 * Отправляет найденные значения пользователю
	 */
	private async sendValuesToUser(
		modify: IModify,
		room: IRoom,
		key: string,
		values: string[]
	): Promise<void> {
		if (!values || values.length === 0) {
			return;
		}

		const formatted = this.formatValuesForDisplay(key, values);
		await this.sendMessage(modify, room, formatted);
		this.getLogger().debug('Значения отправлены пользователю', { key, count: values.length });
	}

	private formatValuesForDisplay(key: string, values: string[]): string {
		if (values.length === 1) {
			return `*Ключ:* ${key}\n*Значение:* ${values[0]}`;
		}

		const lines = values.map((value, index) => `${index + 1}. ${value}`).join('\n');
		return `*Ключ:* ${key}\n*Значения (${values.length}):*\n${lines}`;
	}

	/**
	 * Парсит команду добавления значения (формат: "ключ:значение")
	 */
	private parseKeyValue(text: string): KeyValuePair | null {
		if (!text) {
			return null;
		}

		const colonIndex = text.indexOf(':');
		if (colonIndex <= 0) {
			return null;
		}

		const key = text.substring(0, colonIndex).trim();
		const value = text.substring(colonIndex + 1).trim();

		if (!this.isValidKey(key) || !this.isValidValue(value)) {
			return null;
		}

		return { key, value };
	}

	private extractCommandPayload(text: string, command: string): string {
		const trimmed = text?.trim() || '';
		const prefix = `${GlossaryBotApp.COMMAND_PREFIX}${command}`;

		if (!trimmed.toLowerCase().startsWith(prefix)) {
			return '';
		}

		return trimmed.substring(prefix.length).trim();
	}

	/**
	 * Обрабатывает команду !add
	 */
	private async handleAddCommand(
		message: IMessage,
		read: IRead,
		persistence: IPersistence,
		modify: IModify
	): Promise<void> {
		const text = message.text?.trim() || '';
		const commandText = this.extractCommandPayload(text, GlossaryBotApp.COMMANDS.ADD);
		
		const pair = this.parseKeyValue(commandText);
		if (!pair) {
			await this.sendMessage(modify, message.room, GlossaryBotApp.MESSAGES.INVALID_ADD_FORMAT);
			return;
		}

		this.getLogger().info('Обработка команды добавления значения', { key: pair.key, value: pair.value });

		const result = await this.addValueToKey(read, persistence, pair.key, pair.value, message.sender);
		const responseText = result.added
			? GlossaryBotApp.MESSAGES.VALUE_ADDED(pair.key, pair.value)
			: result.reason === 'duplicate'
				? GlossaryBotApp.MESSAGES.DUPLICATE_VALUE(pair.key)
				: GlossaryBotApp.MESSAGES.SAVE_ERROR;

		await this.sendMessage(modify, message.room, responseText);
	}

	/**
	 * Парсит команду !multi-add (множественное добавление)
	 */
	private parseMultiAdd(text: string): KeyValuePair[] {
		// Разбиваем по строкам и обрабатываем каждую
		const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
		const pairs: KeyValuePair[] = [];

		for (const line of lines) {
			// Убираем точку с запятой в конце, если есть
			const cleanLine = line.endsWith(';') ? line.slice(0, -1).trim() : line;
			const pair = this.parseKeyValue(cleanLine);
			if (pair) {
				pairs.push(pair);
			}
		}

		return pairs;
	}

	/**
	 * Обрабатывает команду !multi-add
	 */
	private async handleMultiAddCommand(
		message: IMessage,
		read: IRead,
		persistence: IPersistence,
		modify: IModify
	): Promise<void> {
		const text = message.text?.trim() || '';
		const commandText = this.extractCommandPayload(text, GlossaryBotApp.COMMANDS.MULTI_ADD);
		
		const pairs = this.parseMultiAdd(commandText);
		if (pairs.length === 0) {
			await this.sendMessage(modify, message.room, GlossaryBotApp.MESSAGES.INVALID_MULTI_ADD_FORMAT);
			return;
		}

		this.getLogger().info('Обработка команды множественного добавления', { count: pairs.length });

		let added = 0;
		let duplicates = 0;
		let errors = 0;

		for (const pair of pairs) {
			const result = await this.addValueToKey(read, persistence, pair.key, pair.value, message.sender);
			if (result.added) {
				added += 1;
			} else if (result.reason === 'duplicate') {
				duplicates += 1;
			} else {
				errors += 1;
			}
		}

		const responseParts = [`✅ Добавлено значений: ${added}`];
		if (duplicates > 0) {
			responseParts.push(`⚠️ Пропущено дубликатов: ${duplicates}`);
		}
		if (errors > 0) {
			responseParts.push(`❌ Ошибок: ${errors}`);
		}

		await this.sendMessage(modify, message.room, responseParts.join('\n'));
	}

	/**
	 * Обрабатывает команду !remove
	 */
	private async handleRemoveCommand(
		message: IMessage,
		read: IRead,
		persistence: IPersistence,
		modify: IModify
	): Promise<void> {
		const text = message.text?.trim() || '';
		const commandText = this.extractCommandPayload(text, GlossaryBotApp.COMMANDS.REMOVE);

		const pair = this.parseKeyValue(commandText);

		if (pair) {
			this.getLogger().info('Обработка команды удаления значения', { key: pair.key, value: pair.value });
			const removed = await this.removeValueForKey(read, persistence, pair.key, pair.value);
			const responseText = removed
				? GlossaryBotApp.MESSAGES.VALUE_REMOVED(pair.key, pair.value)
				: GlossaryBotApp.MESSAGES.VALUE_NOT_FOUND(pair.key, pair.value);
			await this.sendMessage(modify, message.room, responseText);
			return;
		}

		const key = commandText.trim();
		if (!this.isValidKey(key)) {
			await this.sendMessage(modify, message.room, GlossaryBotApp.MESSAGES.INVALID_REMOVE_FORMAT);
			return;
		}

		this.getLogger().info('Обработка команды удаления ключа', { key });
		const removed = await this.removeKey(read, persistence, key);
		const responseText = removed
			? GlossaryBotApp.MESSAGES.KEY_REMOVED(key)
			: GlossaryBotApp.MESSAGES.KEY_NOT_FOUND(key);
		await this.sendMessage(modify, message.room, responseText);
	}

	/**
	 * Обрабатывает команду !details
	 */
	private async handleDetailsCommand(
		message: IMessage,
		read: IRead,
		modify: IModify
	): Promise<void> {
		const text = message.text?.trim() || '';
		const commandText = this.extractCommandPayload(text, GlossaryBotApp.COMMANDS.DETAILS);
		const pair = this.parseKeyValue(commandText);

		if (!pair) {
			await this.sendMessage(modify, message.room, GlossaryBotApp.MESSAGES.INVALID_DETAILS_FORMAT);
			return;
		}

		const entry = await this.getEntryForKey(read, pair.key);
		if (!entry) {
			await this.sendMessage(modify, message.room, GlossaryBotApp.MESSAGES.KEY_NOT_FOUND(pair.key));
			return;
		}

		const normalizedValue = this.normalizeValue(pair.value);
		const valueInfo = entry.find(item => this.normalizeValue(item.value) === normalizedValue);
		if (!valueInfo) {
			await this.sendMessage(
				modify,
				message.room,
				GlossaryBotApp.MESSAGES.VALUE_NOT_FOUND(pair.key, pair.value)
			);
			return;
		}

		const formattedDate = this.formatDate(valueInfo.createdAt);
		const detailsText =
			`*Ключ:* ${pair.key}\n` +
			`*Значение:* ${valueInfo.value}\n` +
			`*Добавлено:* ${formattedDate}\n` +
			`*Автор:* ${valueInfo.createdBy}`;

		await this.sendMessage(modify, message.room, detailsText);
	}

	/**
	 * Обрабатывает команду !help
	 */
	private async handleHelpCommand(
		modify: IModify,
		room: IRoom
	): Promise<void> {
		const helpText = `*📖 Справка по командам бота-глоссария*\n\n` +
			`*!add <ключ>:<значение>*\n` +
			`Добавляет значение для указанного ключа.\n` +
			`Пример: \`!add API:Application Programming Interface\`\n\n` +
			`*!multi-add*\n` +
			`Позволяет добавить несколько ключей/значений за раз.\n` +
			`Пример:\n\`\`\`\n!multi-add\nAPI:Application Programming Interface;\nREST:Representational State Transfer;\n\`\`\`\n\n` +
			`*!remove <ключ>*\n` +
			`Удаляет весь ключ и все его значения.\n` +
			`Пример: \`!remove API\`\n\n` +
			`*!remove <ключ>:<значение>*\n` +
			`Удаляет только одно конкретное значение для ключа.\n` +
			`Пример: \`!remove API:Application Programming Interface\`\n\n` +
			`*!details <ключ>:<значение>*\n` +
			`Показывает дату добавления и e-mail автора значения.\n` +
			`Пример: \`!details API:Application Programming Interface\`\n\n` +
			`*!help*\n` +
			`Показывает эту справку.\n\n` +
			`*Поиск*\n` +
			`Если отправить просто ключ (без префикса !), бот найдет и покажет все значения для этого ключа.`;

		await this.sendMessage(modify, room, helpText);
	}

	private async shouldProcessMessage(message: IMessage, read: IRead): Promise<boolean> {
		if (message.room.type !== GlossaryBotApp.ROOM_TYPE_DIRECT) {
			this.getLogger().debug('Сообщение не является приватным, игнорируем');
			return false;
		}

		const appUser = await read.getUserReader().getAppUser();
		if (!appUser || message.sender.id === appUser.id) {
			this.getLogger().debug('Сообщение от самого бота, игнорируем');
			return false;
		}

		if (!message.text?.trim()) {
			this.getLogger().debug('Пустое сообщение, игнорируем');
			return false;
		}

		return true;
	}

	private async handleKeySearch(
		key: string,
		read: IRead,
		modify: IModify,
		room: IRoom
	): Promise<void> {
		if (!this.isValidKey(key)) {
			await this.sendMessage(modify, room, GlossaryBotApp.MESSAGES.INVALID_SEARCH_KEY);
			return;
		}

		this.getLogger().info('Обработка ключа', { key });
		const values = await this.getValuesForKey(read, key);

		if (values && values.length > 0) {
			this.getLogger().info('Найдены значения для ключа', { key, count: values.length });
			await this.sendValuesToUser(modify, room, key, values);
		} else {
			this.getLogger().info('Значения не найдены, предлагаем добавить', { key });
			await this.sendMessage(modify, room, GlossaryBotApp.MESSAGES.KEY_NOT_FOUND_SEARCH(key));
		}
	}

	private async executeCommand(
		commandType: CommandType,
		message: IMessage,
		read: IRead,
		persistence: IPersistence,
		modify: IModify
	): Promise<void> {
		const { ADD, MULTI_ADD, REMOVE, DETAILS, HELP } = GlossaryBotApp.COMMANDS;

		switch (commandType) {
			case ADD:
				await this.handleAddCommand(message, read, persistence, modify);
				return;
			case MULTI_ADD:
				await this.handleMultiAddCommand(message, read, persistence, modify);
				return;
			case REMOVE:
				await this.handleRemoveCommand(message, read, persistence, modify);
				return;
			case DETAILS:
				await this.handleDetailsCommand(message, read, modify);
				return;
			case HELP:
				await this.handleHelpCommand(modify, message.room);
				return;
			default:
				this.getLogger().warn('Неизвестный тип команды', { commandType });
		}
	}

	/**
	 * Проверяет, является ли сообщение командой
	 */
	private isCommand(text: string): boolean {
		const trimmed = text?.trim() || '';
		return trimmed.startsWith(GlossaryBotApp.COMMAND_PREFIX);
	}

	private matchesCommand(text: string, command: string): boolean {
		if (!this.isCommand(text)) {
			return false;
		}

		const trimmed = text.trim();
		const prefix = `${GlossaryBotApp.COMMAND_PREFIX}${command}`;
		if (!trimmed.startsWith(prefix)) {
			return false;
		}

		const nextChar = trimmed.charAt(prefix.length);
		return nextChar === '' || /\s/.test(nextChar);
	}

	/**
	 * Определяет тип команды
	 */
	private getCommandType(text: string): CommandType {
		const { ADD, MULTI_ADD, REMOVE, DETAILS, HELP } = GlossaryBotApp.COMMANDS;

		if (this.matchesCommand(text, ADD)) {
			return ADD;
		}
		if (this.matchesCommand(text, MULTI_ADD)) {
			return MULTI_ADD;
		}
		if (this.matchesCommand(text, REMOVE)) {
			return REMOVE;
		}
		if (this.matchesCommand(text, DETAILS)) {
			return DETAILS;
		}
		if (this.matchesCommand(text, HELP)) {
			return HELP;
		}

		return null;
	}

	public async executePostMessageSent(
		message: IMessage,
		read: IRead,
		_http: IHttp,
		persistence: IPersistence,
		modify: IModify
	): Promise<void> {
		this.getLogger().debug('Получено сообщение', {
			messageId: message.id,
			roomId: message.room.id,
			roomType: message.room.type,
			senderId: message.sender.id,
		});

		if (!(await this.shouldProcessMessage(message, read))) {
			return;
		}

		const text = message.text?.trim() || '';
		const commandType = this.getCommandType(text);

		if (commandType) {
			this.getLogger().debug('Обнаружена команда', { commandType });
			await this.executeCommand(commandType, message, read, persistence, modify);
			return;
		}

		await this.handleKeySearch(text, read, modify, message.room);
	}
}
