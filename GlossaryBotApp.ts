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

export class GlossaryBotApp extends App implements IPostMessageSent {
	private readonly COMMAND_PREFIX = '!';
	private readonly COMMANDS = {
		ADD: 'add',
		MULTI_ADD: 'multi-add',
		REMOVE: 'remove',
		DETAILS: 'details',
		HELP: 'help',
	};

	constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
		super(info, logger, accessors);
	}

	/**
	 * Нормализует ключ (приводит к нижнему регистру для регистронезависимого поиска)
	 */
	private normalizeKey(key: string): string {
		return key.trim().toLowerCase();
	}

	/**
refactoring	 * Возвращает e-mail пользователя
	 */
	private getUserEmail(user: IUser): string {
		const primaryEmail = user.emails?.find(email => email.verified) ?? user.emails?.[0];
		return primaryEmail?.address || user.username || user.name || 'unknown';
	}

	private formatDate(dateIso: string): string {
		const date = new Date(dateIso);
		return isNaN(date.getTime()) ? dateIso : date.toLocaleString();
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
		try {
			const association = this.getAssociationForKey(key);
			const records = await read.getPersistenceReader().readByAssociation(association);

			if (!records || records.length === 0) {
				return null;
			}

			const [entry] = records as Array<{ values?: GlossaryValue[] }>;
			if (!entry?.values || entry.values.length === 0) {
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
		return entry ? entry.map(item => item.value) : null;
	}

	/**
	 * Сохраняет список значений для ключа (полностью перезаписывает)
	 */
	private async saveValuesForKey(
		persistence: IPersistence,
		key: string,
		values: GlossaryValue[]
	): Promise<void> {
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
	): Promise<{ added: boolean; reason?: string }> {
		try {
			const normalizedValue = value.trim();
			const existingValues = (await this.getEntryForKey(read, key)) ?? [];
			const hasDuplicate = existingValues.some(item => item.value.toLowerCase() === normalizedValue.toLowerCase());

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
		const entry = await this.getEntryForKey(read, key);
		if (!entry) {
			return false;
		}

		const association = this.getAssociationForKey(key);
		await persistence.removeByAssociation(association);
		this.getLogger().debug('Ключ удален из БД', { key: this.normalizeKey(key) });
		return true;
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
		const entry = await this.getEntryForKey(read, key);
		if (!entry || entry.length === 0) {
			return false;
		}

		const filtered = entry.filter(
			item => item.value.toLowerCase() !== value.trim().toLowerCase()
		);

		if (filtered.length === entry.length) {
			return false;
		}

		if (filtered.length === 0) {
			const association = this.getAssociationForKey(key);
			await persistence.removeByAssociation(association);
		} else {
			await this.saveValuesForKey(persistence, key, filtered);
		}

		this.getLogger().debug('Значение удалено из БД', { key: this.normalizeKey(key), value });
		return true;
	}

	/**
	 * Отправляет сообщение пользователю
	 */
	private async sendMessage(
		modify: IModify,
		room: IRoom,
		text: string
	): Promise<void> {
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
		let text: string;
		if (values.length === 1) {
			text = `*Ключ:* ${key}\n*Значение:* ${values[0]}`;
		} else {
			text = `*Ключ:* ${key}\n*Значения (${values.length}):*\n${values
				.map((v, i) => `${i + 1}. ${v}`)
				.join('\n')}`;
		}
		await this.sendMessage(modify, room, text);
		this.getLogger().debug('Значения отправлены пользователю', { key, count: values.length });
	}

	/**
	 * Парсит команду добавления значения (формат: "ключ:значение")
	 */
	private parseKeyValue(text: string): KeyValuePair | null {
		const colonIndex = text.indexOf(':');
		if (colonIndex === -1) {
			return null;
		}

		const key = text.substring(0, colonIndex).trim();
		const value = text.substring(colonIndex + 1).trim();

		if (!key || !value) {
			return null;
		}

		return { key, value };
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
		const commandText = text.substring(this.COMMAND_PREFIX.length + this.COMMANDS.ADD.length).trim();
		
		const pair = this.parseKeyValue(commandText);
		if (!pair) {
			await this.sendMessage(
				modify,
				message.room,
				'❌ Неверный формат команды. Используйте: `!add <ключ>:<значение>`'
			);
			return;
		}

		this.getLogger().debug('Обработка команды добавления значения', { key: pair.key, value: pair.value });

		const result = await this.addValueToKey(read, persistence, pair.key, pair.value, message.sender);

		if (result.added) {
			await this.sendMessage(
				modify,
				message.room,
				`✅ Значение успешно добавлено для ключа "*${pair.key}*":\n${pair.value}`
			);
		} else {
			const reasonText = result.reason === 'duplicate'
				? `Такое значение уже существует для ключа "*${pair.key}*".`
				: 'Произошла ошибка при сохранении.';
			await this.sendMessage(
				modify,
				message.room,
				`❌ ${reasonText}`
			);
		}
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
		const commandText = text.substring(this.COMMAND_PREFIX.length + this.COMMANDS.MULTI_ADD.length).trim();
		
		const pairs = this.parseMultiAdd(commandText);
		if (pairs.length === 0) {
			await this.sendMessage(
				modify,
				message.room,
				'❌ Неверный формат команды. Используйте:\n`!multi-add\n<ключ1>:<значение1>;\n<ключ2>:<значение2>;`'
			);
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
				continue;
			}

			if (result.reason === 'duplicate') {
				duplicates += 1;
			} else {
				errors += 1;
			}
		}

		let responseText = `✅ Добавлено значений: ${added}`;
		if (duplicates > 0) {
			responseText += `\n⚠️ Пропущено дубликатов: ${duplicates}`;
		}
		if (errors > 0) {
			responseText += `\n❌ Ошибок: ${errors}`;
		}

		await this.sendMessage(modify, message.room, responseText);
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
		const commandText = text.substring(this.COMMAND_PREFIX.length + this.COMMANDS.REMOVE.length).trim();
		
		const pair = this.parseKeyValue(commandText);
		
		if (pair) {
			// Удаляем конкретное значение
			this.getLogger().info('Обработка команды удаления значения', { key: pair.key, value: pair.value });
			const removed = await this.removeValueForKey(read, persistence, pair.key, pair.value);
			
			if (removed) {
				await this.sendMessage(
					modify,
					message.room,
					`✅ Значение "*${pair.value}*" успешно удалено для ключа "*${pair.key}*"`
				);
			} else {
				await this.sendMessage(
					modify,
					message.room,
					`❌ Значение "*${pair.value}*" не найдено для ключа "*${pair.key}*"`
				);
			}
		} else {
			// Удаляем весь ключ
			const key = commandText.trim();
			if (!key) {
				await this.sendMessage(
					modify,
					message.room,
					'❌ Неверный формат команды. Используйте:\n`!remove <ключ>` - удалить весь ключ\n`!remove <ключ>:<значение>` - удалить конкретное значение'
				);
				return;
			}

			this.getLogger().info('Обработка команды удаления ключа', { key });
			const removed = await this.removeKey(read, persistence, key);
			
			if (removed) {
				await this.sendMessage(
					modify,
					message.room,
					`✅ Ключ "*${key}*" и все его значения успешно удалены`
				);
			} else {
				await this.sendMessage(
					modify,
					message.room,
					`❌ Ключ "*${key}*" не найден`
				);
			}
		}
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
		const commandText = text.substring(this.COMMAND_PREFIX.length + this.COMMANDS.DETAILS.length).trim();
		const pair = this.parseKeyValue(commandText);

		if (!pair) {
			await this.sendMessage(
				modify,
				message.room,
				'❌ Неверный формат команды. Используйте: `!details <ключ>:<значение>`'
			);
			return;
		}

		const entry = await this.getEntryForKey(read, pair.key);
		if (!entry) {
			await this.sendMessage(modify, message.room, `❌ Ключ "*${pair.key}*" не найден`);
			return;
		}

		const valueInfo = entry.find(item => item.value.toLowerCase() === pair.value.trim().toLowerCase());
		if (!valueInfo) {
			await this.sendMessage(
				modify,
				message.room,
				`❌ Значение "*${pair.value}*" не найдено для ключа "*${pair.key}*"`
			);
			return;
		}

		const formattedDate = this.formatDate(valueInfo.createdAt);
		await this.sendMessage(
			modify,
			message.room,
			`*Ключ:* ${pair.key}\n*Значение:* ${valueInfo.value}\n*Добавлено:* ${formattedDate}\n*Автор:* ${valueInfo.createdBy}`
		);
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

	/**
	 * Проверяет, является ли сообщение командой
	 */
	private isCommand(text: string): boolean {
		return text.trim().startsWith(this.COMMAND_PREFIX);
	}

	private matchesCommand(text: string, command: string): boolean {
		if (!this.isCommand(text)) {
			return false;
		}

		const trimmed = text.trim();
		const prefix = `${this.COMMAND_PREFIX}${command}`;
		if (!trimmed.startsWith(prefix)) {
			return false;
		}

		const nextChar = trimmed.charAt(prefix.length);
		return nextChar === '' || /\s/.test(nextChar);
	}

	/**
	 * Определяет тип команды
	 */
	private getCommandType(text: string): string | null {
		if (this.matchesCommand(text, this.COMMANDS.ADD)) {
			return this.COMMANDS.ADD;
		}
		if (this.matchesCommand(text, this.COMMANDS.MULTI_ADD)) {
			return this.COMMANDS.MULTI_ADD;
		}
		if (this.matchesCommand(text, this.COMMANDS.REMOVE)) {
			return this.COMMANDS.REMOVE;
		}
		if (this.matchesCommand(text, this.COMMANDS.DETAILS)) {
			return this.COMMANDS.DETAILS;
		}
		if (this.matchesCommand(text, this.COMMANDS.HELP)) {
			return this.COMMANDS.HELP;
		}

		return null;
	}

	public async executePostMessageSent(
		message: IMessage,
		read: IRead,
		http: IHttp,
		persistence: IPersistence,
		modify: IModify
	): Promise<void> {
		this.getLogger().debug('Получено сообщение', {
			messageId: message.id,
			roomId: message.room.id,
			roomType: message.room.type,
			senderId: message.sender.id,
		});

		// Проверяем, что это приватное сообщение (Direct Message)
		if (message.room.type !== 'd') {
			this.getLogger().debug('Сообщение не является приватным, игнорируем');
			return;
		}

		// Игнорируем сообщения от самого бота
		const appUser = await read.getUserReader().getAppUser();
		if (!appUser || message.sender.id === appUser.id) {
			this.getLogger().debug('Сообщение от самого бота, игнорируем');
			return;
		}

		const text = message.text?.trim() || '';
		if (!text) {
			this.getLogger().debug('Пустое сообщение, игнорируем');
			return;
		}

		// Обрабатываем команды
		const commandType = this.getCommandType(text);
		if (commandType) {
			this.getLogger().debug('Обнаружена команда', { commandType });

			switch (commandType) {
				case this.COMMANDS.ADD:
					await this.handleAddCommand(message, read, persistence, modify);
					return;

				case this.COMMANDS.MULTI_ADD:
					await this.handleMultiAddCommand(message, read, persistence, modify);
					return;

				case this.COMMANDS.REMOVE:
					await this.handleRemoveCommand(message, read, persistence, modify);
					return;

				case this.COMMANDS.DETAILS:
					await this.handleDetailsCommand(message, read, modify);
					return;

				case this.COMMANDS.HELP:
					await this.handleHelpCommand(modify, message.room);
					return;
			}
		}

		// Иначе обрабатываем как ключ для поиска
		const key = text;
		this.getLogger().debug('Обработка ключа', { key, senderId: message.sender.id });

		// Получаем значения для ключа из БД
		const values = await this.getValuesForKey(read, key);

		if (values && values.length > 0) {
			// Если значения найдены, отправляем их
			this.getLogger().debug('Найдены значения для ключа', { key, count: values.length });
			await this.sendValuesToUser(modify, message.room, key, values);
		} else {
			// Если значений нет, предлагаем добавить
			this.getLogger().debug('Значения не найдены, предлагаем добавить', { key });
			await this.sendMessage(
				modify,
				message.room,
				`Значение для ключа "*${key}*" не найдено.\n\n` +
				`Чтобы добавить значение, используйте команду:\n` +
				`\`!add ${key}: <ваше значение>\``
			);
		}
	}
}
