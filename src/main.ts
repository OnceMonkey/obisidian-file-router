import { App, Editor, MarkdownView, Modal, Plugin, PluginSettingTab, Setting, TFile, TFolder, FileManager } from 'obsidian';
import { Notice } from 'obsidian';
import { normalizePath } from "obsidian";

// Remember to rename these classes and interfaces!

interface FileRouterPluginSettings {
	// 当添加新附件时，是否保留原名|自动使用时间后缀 
	attachmentFormat: string

	// 跳过哪些文件？正则表达式。
	// 例如：\.md$ 表示跳过所有以 .md 结尾
	skipFiles: string

	// 当目标文件夹不存在时，是否自动创建？
	autoCreateDstDir: boolean

	// 当目标文件夹下存在相同文件时，是否自动添加时间后缀？如果不添加则取消移动。
	// autoTimeSuffix: boolean

	// 描述文件映射的正则表达式和具体的目录。
	fileMapping: Array<{ regex: string; targetDir: string }>

}

const DEFAULT_SETTINGS: FileRouterPluginSettings = {
	attachmentFormat: "${fileName}.${fileExtention}",
	// attachmentFormat: "${fileName}_${timestamp}.${fileExtention}",

	skipFiles: "\.(md|canvas)$",

	autoCreateDstDir: true,

	// autoTimeSuffix: true,

	fileMapping: [
		{ regex: "\.(png|jpg|jpeg|bmp|gif|webp)$", targetDir: "attachments/image" },
		{ regex: "\.(pdf)$", targetDir: "attachments/pdf" }
	]
}


/**
 * 渲染模板字符串，将变量替换为实际值。
 * @param template 模板字符串，使用 ${variable} 语法。
 * @param variables 变量对象，包含要替换的变量名和对应的值。
 * @returns 替换后的字符串。
 * @example
 * const result = renderTemplate("Hello, ${name}!", { name: "World" });
 * console.log(result); // 输出 "Hello, World!"
 */
function renderTemplate(template: string, variables: Record<string, string | number>): string {
	return template.replace(/\$\{(.*?)\}/g, (_, key) => {
		// 去除key前后空格
		const trimmedKey = key.trim();
		if (trimmedKey in variables) {
			return String(variables[trimmedKey]);
		} else {
			console.warn(`Missing value for key: ${trimmedKey}`);
			return '';
		}
	});
}


// 定义文件映射项的类型, 已弃用
// type FileMappingItem = { regex: string; targetDir: string };
// type FileMappingTuple = [string, string][];

// function convertFileMapping(input: unknown): FileMappingItem[] {
//   if (Array.isArray(input)) {
//     return (input as FileMappingTuple).map(([regex, targetDir]) => ({
//       regex,
//       targetDir
//     }));
//   } else {
//     console.warn('fileMapping 格式无效，期望是一个二维数组');
//     return [];
//   }
// }


export default class FileRouterPlugin extends Plugin {
	settings: FileRouterPluginSettings;
	createdQueue: TFile[] = [];

	async onload() {
		await this.loadSettings();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		await this.app.workspace.onLayoutReady(async () => {

			// 记录文件创建队列
			this.registerEvent(
				this.app.vault.on("create", async (file: TFile) => {
					// 如果是文件夹，则跳过处理。
					if (file instanceof TFolder) { return; }

					// 跳过指定文件。
					const skipFiles = this.settings.skipFiles
					if (file.path.match(skipFiles)) {
						console.log(`检测到新创建文件, 但是跳过: ${file.path}`);
						return;
					}

					// 将待处理的文件推入队列。
					this.createdQueue.push(file);
					console.log("检测到新创建文件, 加入文件队列:", file.path);
				})
			);

			// 处理文件队列
			this.registerEvent(
				// 当页面发生编辑的时候。document: 正在编辑的文档。
				this.app.vault.on("modify", (document: TFile) => {
					if (this.createdQueue.length <= 0) { return };
					console.log("目前文件队列：", this.createdQueue);

					// 读取配置里面的映射表，正则表达 -> 目标目录。
					const fileMappings = this.settings.fileMapping;
					console.log("用户配置：", fileMappings);

					// 遍历文件队列, 直到createdQueue没有任何元素
					while (this.createdQueue.length > 0) {
						const file = this.createdQueue.shift(); // 获取并移除队列的第一个元素

						// 使用 processFile 函数处理文件
						if (file) {
							this.app.vault.adapter.process(document.path, (pdata) => {
								this.processFile(file);
								return pdata;
							});
						}
					}

				})
			)

		});

	}


	// 定义文件处理函数
	private async processFile(file: TFile): Promise<void> {
		console.log(`----------File process ${file.path} start----------`);

		// 检查文件是否存在
		const exist = await this.app.vault.adapter.exists(file.path, true);
		if (!exist) {
			console.error("File process error - file does not exist:", file.path);
			return;
		}

		const fileMappings = this.settings.fileMapping;
		const sourcePath = file.path
		const fileName: string = file.basename
		const fileExtention: string = file.extension
		const timestamp = new Date().toISOString().replace(/[:\-\.]/g, "");
		// console.log("sourcePath:", sourcePath);
		// console.log("fileanme:", fileanme);
		// console.log("fileExtention:", fileExtention);
		// console.log("timestamp:", timestamp);

		var targetDir: string = ""
		var dstPath: string = ""

		// 遍历文件映射表, 查询映射后的地址
		var matchSuccess = false;
		for (const mapping of fileMappings) {
			const regex = mapping.regex;
			const directory = mapping.targetDir;
			// console.log(regex, directory);

			if (file.path.match(regex)) {
				targetDir = directory
				matchSuccess = true;
				console.log(`Matched rule: ${regex} -> ${directory}`);
				// 如果匹配到一个规则，就结束处理
				break;
			}
		}

		// 如果没有匹配到任何规则，结束处理
		if (!matchSuccess) {
			console.warn("No matching rule found for file:", file.path);
			return;
		}

		// 当autoCreateDstDir为true时，如果目标目录不存在则创建。
		const targetDirExists = await this.app.vault.adapter.exists(targetDir, true);
		if (!targetDirExists && this.settings.autoCreateDstDir) {
			try {
				await this.app.vault.adapter.mkdir(targetDir);
				console.log(`Created directory: ${targetDir}`);
			} catch (error) {
				console.error("Error creating directory:", error);
				return;
			}
		}

		// 根据用户自定义的规则, 指定文件名称.
		var targetFile: string = renderTemplate(this.settings.attachmentFormat, {
			"fileName": fileName,
			"fileExtention": fileExtention,
			"timestamp": timestamp,
		})
		// 如果targetFile是空字符串，则使用默认的文件名。
		if (!targetFile) {
			targetFile = `${fileName}.${fileExtention}`;
			console.warn(`Target file name is empty, using default:${targetFile}.`);
		}
		dstPath = normalizePath(`${targetDir}/${targetFile}`);


		const dstPathExists = await this.app.vault.adapter.exists(dstPath, true);
		if (dstPathExists) {
			// 如果目标路径已存在文件，根据 autoTimeSuffix 设置处理
			// if (this.settings.autoTimeSuffix) {
			// 	// 由于wiki链接的不正确更新, 此步骤会导致多处链接被修改。 因此目前禁用添加后缀处理
			// 	// dstPath = normalizePath(`${targetDir}/${fileanme}_${timestamp}.${fileExtention}`);
			// 	console.warn(`Target file exists. Not implemented yet to add time suffix, timestamp: ${timestamp}.`);
			// 	return;
			// } else {
			// 	// 跳过移动
			// 	console.warn(`Target file exists. Skipping move: ${dstPath}`);
			// 	return;
			// }

			console.warn(`Target file exists. Skipping move: ${dstPath}`);
		}

		// 重命名文件实现文件移动
		try {
			await this.app.fileManager.renameFile(file, dstPath);
			console.log(`Finished renaming file: ${sourcePath} to ${dstPath}.`);
		} catch (error) {
			console.error("Error renaming file:", error);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		console.log("Loaded settings:", this.settings);
		// this.settings.fileMapping = convertFileMapping(this.settings.fileMapping);

	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// class SampleModal extends Modal {
// 	constructor(app: App) {
// 		super(app);
// 	}

// 	onOpen() {
// 		const { contentEl } = this;
// 		contentEl.setText('Woah!');
// 	}

// 	onClose() {
// 		const { contentEl } = this;
// 		contentEl.empty();
// 	}
// }

class SampleSettingTab extends PluginSettingTab {
	plugin: FileRouterPlugin;

	constructor(app: App, plugin: FileRouterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// 1.配置选择性设置
		new Setting(containerEl)
			.setName('附件名称格式')
			.setDesc('使用 ${fileName}、${fileExtention}、${timestamp} 等变量来定义附件名称格式。默认是 "${fileName}.${fileExtention}"。')
			.addText(text => text
				.setPlaceholder('${fileName}.${fileExtention}')
				.setValue(this.plugin.settings.attachmentFormat)
				.onChange(async (value) => {
					this.plugin.settings.attachmentFormat = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('跳过的文件')
			.setDesc('使用正则表达式来定义哪些文件不处理。默认是后缀为md或者是canvas:".(md|canvas)$"。')
			.addText(text => text
				.setPlaceholder('.(md|canvas)$')
				.setValue(this.plugin.settings.skipFiles)
				.onChange(async (value) => {
					this.plugin.settings.skipFiles = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('自动创建目标目录')
			.setDesc('如果目标目录不存在，是否自动创建？')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoCreateDstDir)
				.onChange(async (value) => {
					this.plugin.settings.autoCreateDstDir = value;
					await this.plugin.saveSettings();
				}));



		// 1.配置文件映射表
		containerEl.createEl('h3', { text: '文件映射表' });

		var fileMapping = this.plugin.settings.fileMapping;
		console.log("当前文件映射规则:", fileMapping, typeof fileMapping);

		if (fileMapping.length === 0) {
			// 如果是空对象
			new Setting(containerEl)
				.setName('当前没有任何文件映射规则')
				.setDesc('请添加新的映射规则。');
		} else {
			// 遍历文件映射表，创建设置项
			fileMapping.forEach((item, index) => {
				const setting = new Setting(containerEl);

				let regexInput = item.regex;
				let targetDirInput = item.targetDir;
				// console.log("当前映射规则:", item, typeof item, item.regex, item.targetDir);

				setting.addText(text => text
					.setPlaceholder('正则表达式')
					.setValue(regexInput)
					.onChange(value => {
						regexInput = value;
					}));

				setting.addText(text => text
					.setPlaceholder('目标目录')
					.setValue(targetDirInput)
					.onChange(value => {
						targetDirInput = value;
					}));

				// 上移按钮
				setting.addExtraButton(button =>
					button
						.setIcon('arrow-up')
						.setTooltip('上移')
						.setDisabled(index === 0)
						.onClick(async () => {
							[fileMapping[index - 1], fileMapping[index]] = [fileMapping[index], fileMapping[index - 1]];
							await this.plugin.saveSettings();
							this.display();
						}));

				// 下移按钮
				setting.addExtraButton(button =>
					button
						.setIcon('arrow-down')
						.setTooltip('下移')
						.setDisabled(index === fileMapping.length - 1)
						.onClick(async () => {
							[fileMapping[index], fileMapping[index + 1]] = [fileMapping[index + 1], fileMapping[index]];
							await this.plugin.saveSettings();
							this.display();
						}));

				// 删除按钮
				setting.addExtraButton(button =>
					button
						.setIcon('trash')
						.setTooltip('删除')
						.onClick(async () => {
							fileMapping.splice(index, 1);
							await this.plugin.saveSettings();
							this.display();
						}));

				// 保存按钮
				setting.addButton(button =>
					button
						.setIcon('checkmark')
						.setTooltip('保存')
						.onClick(async () => {
							fileMapping[index] = {
								regex: regexInput,
								targetDir: targetDirInput
							};
							await this.plugin.saveSettings();
							this.display();
						}));
			});

		}

		// ➕ 新增按钮
		new Setting(containerEl)
			.addButton(button => button
				.setButtonText('新增映射规则')
				.setCta()
				.onClick(() => {
					this.plugin.settings.fileMapping.push({ regex: '新正则', targetDir: '目标目录' });
					this.display();
				}));

	}
}
