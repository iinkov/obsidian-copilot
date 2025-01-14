import { BrevilabsClient } from "@/LLMProviders/brevilabsClient";
import ChainManager from "@/LLMProviders/chainManager";
import { CustomModel } from "@/aiParams";
import { parseChatContent, updateChatMemory } from "@/chatUtils";
import { registerBuiltInCommands } from "@/commands";
import CopilotView from "@/components/CopilotView";
import { AddPromptModal } from "@/components/modals/AddPromptModal";
import { AdhocPromptModal } from "@/components/modals/AdhocPromptModal";
import { DebugSearchModal } from "@/components/modals/DebugSearchModal";
import { ListPromptModal } from "@/components/modals/ListPromptModal";
import { LoadChatHistoryModal } from "@/components/modals/LoadChatHistoryModal";
import { OramaSearchModal } from "@/components/modals/OramaSearchModal";
import { RemoveFromIndexModal } from "@/components/modals/RemoveFromIndexModal";
import { SimilarNotesModal } from "@/components/modals/SimilarNotesModal";
import { CHAT_VIEWTYPE, DEFAULT_OPEN_AREA, EVENT_NAMES } from "@/constants";
import { CustomPromptProcessor } from "@/customPromptProcessor";
import { encryptAllKeys } from "@/encryptionService";
import { CustomError } from "@/error";
import { findRelevantNotes } from "@/search/findRelevantNotes";
import { HybridRetriever } from "@/search/hybridRetriever";
import { getAllQAMarkdownContent } from "@/search/searchUtils";
import VectorStoreManager from "@/search/vectorStoreManager";
import { CopilotSettingTab } from "@/settings/SettingsPage";
import {
  getModelKeyFromModel,
  getSettings,
  sanitizeSettings,
  setSettings,
  subscribeToSettingsChange,
} from "@/settings/model";
import SharedState from "@/sharedState";
import { FileParserManager } from "@/tools/FileParserManager";
import {
  Editor,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  TFile,
  TFolder,
  WorkspaceLeaf,
  requestUrl,
} from "obsidian";

export default class CopilotPlugin extends Plugin {
  // A chat history that stores the messages sent and received
  // Only reset when the user explicitly clicks "New Chat"
  sharedState: SharedState;
  chainManager: ChainManager;
  brevilabsClient: BrevilabsClient;
  userMessageHistory: string[] = [];
  vectorStoreManager: VectorStoreManager;
  fileParserManager: FileParserManager;
  settingsUnsubscriber?: () => void;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.settingsUnsubscriber = subscribeToSettingsChange(async () => {
      const settings = getSettings();
      if (settings.enableEncryption) {
        await this.saveData(await encryptAllKeys(settings));
      } else {
        await this.saveData(settings);
      }
      registerBuiltInCommands(this);
    });
    this.addSettingTab(new CopilotSettingTab(this.app, this));
    // Always have one instance of sharedState and chainManager in the plugin
    this.sharedState = new SharedState();

    this.vectorStoreManager = VectorStoreManager.getInstance();

    // Initialize BrevilabsClient
    this.brevilabsClient = BrevilabsClient.getInstance();

    this.chainManager = new ChainManager(this.app, this.vectorStoreManager);

    // Initialize FileParserManager early with other core services
    this.fileParserManager = new FileParserManager(this.brevilabsClient);

    this.registerView(CHAT_VIEWTYPE, (leaf: WorkspaceLeaf) => new CopilotView(leaf, this));

    this.initActiveLeafChangeHandler();

    this.addCommand({
      id: "chat-toggle-window",
      name: "Toggle Copilot Chat Window",
      callback: () => {
        this.toggleView();
      },
    });

    this.addCommand({
      id: "chat-open-window",
      name: "Open Copilot Chat Window",
      callback: async () => {
        this.activateView();
      },
    });

    this.addRibbonIcon("message-square", "Open Copilot Chat", (evt: MouseEvent) => {
      this.activateView();
    });

    registerBuiltInCommands(this);

    const promptProcessor = CustomPromptProcessor.getInstance(this.app.vault);

    this.addCommand({
      id: "add-custom-prompt",
      name: "Add custom prompt",
      callback: () => {
        new AddPromptModal(this.app, async (title: string, prompt: string) => {
          try {
            await promptProcessor.savePrompt(title, prompt);
            new Notice("Custom prompt saved successfully.");
          } catch (e) {
            new Notice("Error saving custom prompt. Please check if the title already exists.");
            console.error(e);
          }
        }).open();
      },
    });

    this.addCommand({
      id: "apply-custom-prompt",
      name: "Apply custom prompt",
      callback: async () => {
        const prompts = await promptProcessor.getAllPrompts();
        const promptTitles = prompts.map((p) => p.title);
        new ListPromptModal(this.app, promptTitles, async (promptTitle: string) => {
          if (!promptTitle) {
            new Notice("Please select a prompt title.");
            return;
          }
          try {
            const prompt = await promptProcessor.getPrompt(promptTitle);
            if (!prompt) {
              new Notice(`No prompt found with the title "${promptTitle}".`);
              return;
            }
            this.processCustomPrompt("applyCustomPrompt", prompt.content);
          } catch (err) {
            console.error(err);
            new Notice("An error occurred.");
          }
        }).open();
      },
    });

    this.addCommand({
      id: "apply-adhoc-prompt",
      name: "Apply ad-hoc custom prompt",
      callback: async () => {
        const modal = new AdhocPromptModal(this.app, async (adhocPrompt: string) => {
          try {
            this.processCustomPrompt("applyAdhocPrompt", adhocPrompt);
          } catch (err) {
            console.error(err);
            new Notice("An error occurred.");
          }
        });

        modal.open();
      },
    });

    this.addCommand({
      id: "delete-custom-prompt",
      name: "Delete custom prompt",
      checkCallback: (checking: boolean) => {
        if (checking) {
          return true;
        }

        promptProcessor.getAllPrompts().then((prompts) => {
          const promptTitles = prompts.map((p) => p.title);
          new ListPromptModal(this.app, promptTitles, async (promptTitle: string) => {
            if (!promptTitle) {
              new Notice("Please select a prompt title.");
              return;
            }

            try {
              await promptProcessor.deletePrompt(promptTitle);
              new Notice(`Prompt "${promptTitle}" has been deleted.`);
            } catch (err) {
              console.error(err);
              new Notice("An error occurred while deleting the prompt.");
            }
          }).open();
        });

        return true;
      },
    });

    this.addCommand({
      id: "edit-custom-prompt",
      name: "Edit custom prompt",
      checkCallback: (checking: boolean) => {
        if (checking) {
          return true;
        }

        promptProcessor.getAllPrompts().then((prompts) => {
          const promptTitles = prompts.map((p) => p.title);
          new ListPromptModal(this.app, promptTitles, async (promptTitle: string) => {
            if (!promptTitle) {
              new Notice("Please select a prompt title.");
              return;
            }

            try {
              const prompt = await promptProcessor.getPrompt(promptTitle);
              if (prompt) {
                new AddPromptModal(
                  this.app,
                  async (title: string, newPrompt: string) => {
                    try {
                      await promptProcessor.updatePrompt(promptTitle, title, newPrompt);
                      new Notice(`Prompt "${title}" has been updated.`);
                    } catch (err) {
                      console.error(err);
                      if (err instanceof CustomError) {
                        new Notice(err.message);
                      } else {
                        new Notice("An error occurred.");
                      }
                    }
                  },
                  prompt.title,
                  prompt.content,
                  false
                ).open();
              } else {
                new Notice(`No prompt found with the title "${promptTitle}".`);
              }
            } catch (err) {
              console.error(err);
              new Notice("An error occurred.");
            }
          }).open();
        });

        return true;
      },
    });

    this.addCommand({
      id: "clear-local-copilot-index",
      name: "Clear Copilot index",
      callback: async () => {
        await this.vectorStoreManager.clearIndex();
      },
    });

    this.addCommand({
      id: "garbage-collect-copilot-index",
      name: "Garbage collect Copilot index (remove files that no longer exist in vault)",
      callback: async () => {
        try {
          const removedDocs = await this.vectorStoreManager.garbageCollectVectorStore();
          new Notice(`${removedDocs} documents removed from Copilot index.`);
        } catch (err) {
          console.error("Error garbage collecting the Copilot index:", err);
          new Notice("An error occurred while garbage collecting the Copilot index.");
        }
      },
    });

    this.addCommand({
      id: "index-vault-to-copilot-index",
      name: "Index (refresh) vault for QA",
      callback: async () => {
        try {
          const indexedFileCount = await this.vectorStoreManager.indexVaultToVectorStore();

          new Notice(`${indexedFileCount} vault files indexed to Copilot index.`);
          console.log(`${indexedFileCount} vault files indexed to Copilot index.`);
        } catch (err) {
          console.error("Error indexing vault to Copilot index:", err);
          new Notice("An error occurred while indexing vault to Copilot index.");
        }
      },
    });

    this.addCommand({
      id: "force-reindex-vault-to-copilot-index",
      name: "Force re-index vault for QA",
      callback: async () => {
        try {
          const indexedFileCount = await this.vectorStoreManager.indexVaultToVectorStore(true);

          new Notice(`${indexedFileCount} vault files re-indexed to Copilot index.`);
          console.log(`${indexedFileCount} vault files re-indexed to Copilot index.`);
        } catch (err) {
          console.error("Error re-indexing vault to Copilot index:", err);
          new Notice("An error occurred while re-indexing vault to Copilot index.");
        }
      },
    });

    this.addCommand({
      id: "load-copilot-chat-conversation",
      name: "Load Copilot Chat conversation",
      callback: () => {
        this.loadCopilotChatHistory();
      },
    });

    this.addCommand({
      id: "find-relevant-notes",
      name: "Find relevant notes to active note",
      callback: async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
          new Notice("No active file");
          return;
        }

        const db = await this.vectorStoreManager.getDb();
        const relevantNotes = await findRelevantNotes({
          db,
          filePath: activeFile.path,
        });
        new SimilarNotesModal(this.app, relevantNotes).open();
      },
    });

    this.addCommand({
      id: "copilot-inspect-index-by-note-paths",
      name: "Inspect Copilot Index by Note Paths (debug)",
      callback: () => {
        new OramaSearchModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: "copilot-debug-search-oramadb",
      name: "Search OramaDB (debug)",
      callback: () => {
        new DebugSearchModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: "copilot-list-indexed-files",
      name: "List all indexed files (debug)",
      callback: async () => {
        try {
          const indexedFiles = await this.vectorStoreManager.getIndexedFiles();
          const indexedFilePaths = new Set(indexedFiles);
          const allMarkdownFiles = this.app.vault.getMarkdownFiles();
          const emptyFiles = new Set<string>();
          const unindexedFiles = new Set<string>();
          const filesWithoutEmbeddings = new Set<string>();

          // Get dbOps for checking embeddings
          const dbOps = await this.vectorStoreManager.getDbOps();

          // Categorize files
          for (const file of allMarkdownFiles) {
            const content = await this.app.vault.cachedRead(file);
            if (!content || content.trim().length === 0) {
              emptyFiles.add(file.path);
            } else if (!indexedFilePaths.has(file.path)) {
              unindexedFiles.add(file.path);
            } else {
              // Check if file has embeddings
              const hasEmbeddings = await dbOps.hasEmbeddings(file.path);
              if (!hasEmbeddings) {
                filesWithoutEmbeddings.add(file.path);
              }
            }
          }

          if (indexedFiles.length === 0 && emptyFiles.size === 0 && unindexedFiles.size === 0) {
            new Notice("No files found to list.");
            return;
          }

          // Create content for the file
          const content = [
            "# Copilot Files Status",
            `- Indexed files: ${indexedFiles.length}`,
            `	- Files missing embeddings: ${filesWithoutEmbeddings.size}`,
            `- Unindexed files: ${unindexedFiles.size}`,
            `- Empty files: ${emptyFiles.size}`,
            "",
            "## Indexed Files",
            ...indexedFiles.map((file) => {
              const noEmbedding = filesWithoutEmbeddings.has(file);
              return `- [[${file}]]${noEmbedding ? " *(embedding missing)*" : ""}`;
            }),
            "",
            "## Unindexed Files",
            ...(unindexedFiles.size > 0
              ? Array.from(unindexedFiles)
                  .sort()
                  .map((file) => `- [[${file}]]`)
              : ["No unindexed files found."]),
            "",
            "## Empty Files",
            ...(emptyFiles.size > 0
              ? Array.from(emptyFiles)
                  .sort()
                  .map((file) => `- [[${file}]]`)
              : ["No empty files found."]),
          ].join("\n");

          // Create or update the file in the vault
          const fileName = `Copilot-Indexed-Files-${new Date().toLocaleDateString().replace(/\//g, "-")}.md`;
          const filePath = `${fileName}`;

          const existingFile = this.app.vault.getAbstractFileByPath(filePath);
          if (existingFile instanceof TFile) {
            await this.app.vault.modify(existingFile, content);
          } else {
            await this.app.vault.create(filePath, content);
          }

          // Open the file
          const file = this.app.vault.getAbstractFileByPath(filePath);
          if (file instanceof TFile) {
            await this.app.workspace.getLeaf().openFile(file);
            new Notice(`Listed ${indexedFiles.length} indexed files`);
          }
        } catch (error) {
          console.error("Error listing indexed files:", error);
          new Notice("Failed to list indexed files.");
        }
      },
    });

    this.addCommand({
      id: "remove-files-from-copilot-index",
      name: "Remove files from Copilot index",
      callback: async () => {
        new RemoveFromIndexModal(this.app, async (filePaths: string[]) => {
          const dbOps = await this.vectorStoreManager.getDbOps();
          try {
            for (const path of filePaths) {
              await dbOps.removeDocs(path);
            }
            await dbOps.saveDB();
            new Notice(`Successfully removed ${filePaths.length} files from the index.`);
          } catch (err) {
            console.error("Error removing files from index:", err);
            new Notice("An error occurred while removing files from the index.");
          }
        }).open();
      },
    });

    this.registerEvent(this.app.workspace.on("editor-menu", this.handleContextMenu));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf && leaf.view instanceof MarkdownView) {
          const file = leaf.view.file;
          if (file) {
            const activeCopilotView = this.app.workspace
              .getLeavesOfType(CHAT_VIEWTYPE)
              .find((leaf) => leaf.view instanceof CopilotView)?.view as CopilotView;

            if (activeCopilotView) {
              const event = new CustomEvent(EVENT_NAMES.ACTIVE_LEAF_CHANGE);
              activeCopilotView.eventTarget.dispatchEvent(event);
            }
          }
        }
      })
    );
  }

  async onunload() {
    // Clean up VectorStoreManager
    if (this.vectorStoreManager) {
      this.vectorStoreManager.onunload();
    }
    this.settingsUnsubscriber?.();

    console.log("Copilot plugin unloaded");
  }

  updateUserMessageHistory(newMessage: string) {
    this.userMessageHistory = [...this.userMessageHistory, newMessage];
  }

  async autosaveCurrentChat() {
    if (getSettings().autosaveChat) {
      const chatView = this.app.workspace.getLeavesOfType(CHAT_VIEWTYPE)[0]?.view as CopilotView;
      if (chatView && chatView.sharedState.chatHistory.length > 0) {
        await chatView.saveChat();
      }
    }
  }

  async processText(
    editor: Editor,
    eventType: string,
    eventSubtype?: string,
    checkSelectedText = true
  ) {
    const selectedText = await editor.getSelection();

    const isChatWindowActive = this.app.workspace.getLeavesOfType(CHAT_VIEWTYPE).length > 0;

    if (!isChatWindowActive) {
      await this.activateView();
    }

    // Without the timeout, the view is not yet active
    setTimeout(() => {
      const activeCopilotView = this.app.workspace
        .getLeavesOfType(CHAT_VIEWTYPE)
        .find((leaf) => leaf.view instanceof CopilotView)?.view as CopilotView;
      if (activeCopilotView && (!checkSelectedText || selectedText)) {
        const event = new CustomEvent(eventType, { detail: { selectedText, eventSubtype } });
        activeCopilotView.eventTarget.dispatchEvent(event);
      }
    }, 0);
  }

  processSelection(editor: Editor, eventType: string, eventSubtype?: string) {
    this.processText(editor, eventType, eventSubtype);
  }

  emitChatIsVisible() {
    const activeCopilotView = this.app.workspace
      .getLeavesOfType(CHAT_VIEWTYPE)
      .find((leaf) => leaf.view instanceof CopilotView)?.view as CopilotView;

    if (activeCopilotView) {
      const event = new CustomEvent(EVENT_NAMES.CHAT_IS_VISIBLE);
      activeCopilotView.eventTarget.dispatchEvent(event);
    }
  }

  initActiveLeafChangeHandler() {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!leaf) {
          return;
        }
        if (leaf.getViewState().type === CHAT_VIEWTYPE) {
          this.emitChatIsVisible();
        }
      })
    );
  }

  private getCurrentEditorOrDummy(): Editor {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    return {
      getSelection: () => {
        const selection = activeView?.editor?.getSelection();
        if (selection) return selection;
        // Default to the entire active file if no selection
        const activeFile = this.app.workspace.getActiveFile();
        return activeFile ? this.app.vault.cachedRead(activeFile) : "";
      },
      replaceSelection: activeView?.editor?.replaceSelection.bind(activeView.editor) || (() => {}),
    } as Partial<Editor> as Editor;
  }

  processCustomPrompt(eventType: string, customPrompt: string) {
    const editor = this.getCurrentEditorOrDummy();
    this.processText(editor, eventType, customPrompt, false);
  }

  toggleView() {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEWTYPE);
    if (leaves.length > 0) {
      this.deactivateView();
    } else {
      this.activateView();
    }
  }

  async activateView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEWTYPE);
    if (leaves.length === 0) {
      if (getSettings().defaultOpenArea === DEFAULT_OPEN_AREA.VIEW) {
        await this.app.workspace.getRightLeaf(false).setViewState({
          type: CHAT_VIEWTYPE,
          active: true,
        });
      } else {
        await this.app.workspace.getLeaf(true).setViewState({
          type: CHAT_VIEWTYPE,
          active: true,
        });
      }
    } else {
      this.app.workspace.revealLeaf(leaves[0]);
    }
    this.emitChatIsVisible();
  }

  async deactivateView() {
    this.app.workspace.detachLeavesOfType(CHAT_VIEWTYPE);
  }

  async loadSettings() {
    const savedSettings = await this.loadData();
    const sanitizedSettings = sanitizeSettings(savedSettings);
    setSettings(sanitizedSettings);
  }

  mergeActiveModels(
    existingActiveModels: CustomModel[],
    builtInModels: CustomModel[]
  ): CustomModel[] {
    const modelMap = new Map<string, CustomModel>();

    // Create a unique key for each model, it's model (name + provider)

    // Add or update existing models in the map
    existingActiveModels.forEach((model) => {
      const key = getModelKeyFromModel(model);
      const existingModel = modelMap.get(key);
      if (existingModel) {
        // If it's a built-in model, preserve the built-in status
        modelMap.set(key, {
          ...model,
          isBuiltIn: existingModel.isBuiltIn || model.isBuiltIn,
        });
      } else {
        modelMap.set(key, model);
      }
    });

    return Array.from(modelMap.values());
  }

  async countTotalTokens(): Promise<number> {
    try {
      const allContent = await getAllQAMarkdownContent(this.app);
      const totalTokens = await this.chainManager.chatModelManager.countTokens(allContent);
      return totalTokens;
    } catch (error) {
      console.error("Error counting tokens: ", error);
      return 0;
    }
  }

  handleContextMenu = (menu: Menu, editor: Editor): void => {
    this.addContextMenu(menu, editor, this);
  };

  addContextMenu = (menu: Menu, editor: Editor, plugin: this): void => {
    menu.addItem((item) => {
      item
        .setTitle("Copilot: Summarize Selection")
        .setIcon("bot")
        .onClick(async (e) => {
          plugin.processSelection(editor, "summarizeSelection");
        });
    });
  };

  async loadCopilotChatHistory() {
    const chatFiles = await this.getChatHistoryFiles();
    if (chatFiles.length === 0) {
      new Notice("No chat history found.");
      return;
    }
    new LoadChatHistoryModal(this.app, chatFiles, this.loadChatHistory.bind(this)).open();
  }

  async getChatHistoryFiles(): Promise<TFile[]> {
    const folder = this.app.vault.getAbstractFileByPath(getSettings().defaultSaveFolder);
    if (!(folder instanceof TFolder)) {
      return [];
    }
    const files = await this.app.vault.getMarkdownFiles();
    return files.filter((file) => file.path.startsWith(folder.path));
  }

  async loadChatHistory(file: TFile) {
    const content = await this.app.vault.read(file);
    const messages = parseChatContent(content);
    this.sharedState.clearChatHistory();
    messages.forEach((message) => this.sharedState.addMessage(message));

    // Update the chain's memory with the loaded messages
    await updateChatMemory(messages, this.chainManager.memoryManager);

    // Check if the Copilot view is already active
    const existingView = this.app.workspace.getLeavesOfType(CHAT_VIEWTYPE)[0];
    if (!existingView) {
      // Only activate the view if it's not already open
      this.activateView();
    } else {
      // If the view is already open, just update its content
      const copilotView = existingView.view as CopilotView;
      copilotView.updateView();
    }
  }

  async customSearchDB(query: string, salientTerms: string[], textWeight: number): Promise<any[]> {
    const hybridRetriever = new HybridRetriever({
      minSimilarityScore: 0.3,
      maxK: 20,
      salientTerms: salientTerms,
      textWeight: textWeight,
    });

    const results = await hybridRetriever.getOramaChunks(query, salientTerms);
    return results.map((doc) => ({
      content: doc.pageContent,
      metadata: doc.metadata,
    }));
  }

  // TODO: Add a setting for this. Disable for now.
  private async checkForUpdates(): Promise<void> {
    try {
      const response = await requestUrl({
        url: "https://api.github.com/repos/logancyang/obsidian-copilot/releases/latest",
        method: "GET",
      });

      const latestVersion = response.json.tag_name.replace("v", "");
      if (this.isNewerVersion(latestVersion, this.manifest.version)) {
        new Notice(
          `A newer version (${latestVersion}) of Obsidian Copilot is available. You are currently on version ${this.manifest.version}. Please update to the latest version.`,
          10000
        );
      }
    } catch (error) {
      console.error("Failed to check for updates:", error);
    }
  }

  private isNewerVersion(latest: string, current: string): boolean {
    const latestParts = latest.split(".").map(Number);
    const currentParts = current.split(".").map(Number);

    for (let i = 0; i < 3; i++) {
      if (latestParts[i] > currentParts[i]) return true;
      if (latestParts[i] < currentParts[i]) return false;
    }
    return false;
  }
}
