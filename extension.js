const vscode = require("vscode");
const cp = require("child_process");
const util = require("util");
const path = require("path");
const os = require("os");

const exec = util.promisify(cp.exec);
const execFile = util.promisify(cp.execFile);
const isMacOS = os.platform() === "darwin";

let stageFilePicker;
let repoEventListener;
let updateTimer;
let fileWasOpened;

const extPrefix = "quickStage";
const whenContext = "QuickStageVisible";
const KEYS = {
  closeSidebarsOnOpen: 'closeSidebarsOnOpen',
  closePreviewOnExit: 'closePreviewOnExit',
  focusScmSidebarOnExit: 'focusScmSidebarOnExit',
  passFocusOnOpenDiff: 'passFocusOnOpenDiff',
  previewDiff: 'previewDiff',
}
const COMMANDS = {
  quickStage: `${extPrefix}.quickStage`,
  openDiff: `${extPrefix}.openDiff`,
  discardChanges: `${extPrefix}.discardChanges`,
  openFile: `${extPrefix}.openFile`,
  stageAll: `${extPrefix}.stageAll`,
  unstageAll: `${extPrefix}.unstageAll`,
  scrollUp: `${extPrefix}.scrollUp`,
  scrollDown: `${extPrefix}.scrollDown`,
  scrollRight: `${extPrefix}.scrollRight`,
  scrollLeft: `${extPrefix}.scrollLeft`,
  scrollPrevChange: `${extPrefix}.scrollPrevChange`,
  scrollNextChange: `${extPrefix}.scrollNextChange`,
};

const STATUS_SYMBOLS = [
  // staged
  'M',  // 0
  'A',  // 1
  'D',  // 2
  'R',  // 3
  'C',  // 4

  // unstaged
  'M',  // 5
  'D',  // 6
  'U',  // 7
  'I',  // 8
];

function useGitApi (){
  return vscode.extensions
  .getExtension("vscode.git")
  .exports.getAPI(1);
}

let scrollTimer;
let scrollCounter = 1;

function getScrollValue(){
  if (scrollTimer){
    clearTimeout(scrollTimer);
  }
  scrollTimer = setTimeout(() => {
    scrollCounter = 0;
  }, 350);
  return Math.min(Math.floor(1 + Math.log2((++scrollCounter + 15)/15)),5)
}

  //   Activate
  // ------------

async function activate(context) {
  context.subscriptions.push(

    stageFilePicker,
    repoEventListener,

    // |--------------------------|
    // |        QuickStage        |
    // |--------------------------|

    vscode.commands.registerCommand(COMMANDS.quickStage, async () => {

      vscode.commands.executeCommand("setContext", whenContext, true); // set When context

      function exit(){
        if (stageFilePicker){stageFilePicker.dispose()};
        if (repoEventListener){repoEventListener.dispose()};
        vscode.commands.executeCommand("setContext", whenContext, false); // remove when context
      }

      // get gitAPI
      const gitAPI = useGitApi()
      if (!gitAPI) {
        vscode.window.showInformationMessage('SCM extension not found')
        return exit();
      }

      //   Repository
      // --------------

      const repositories = useGitApi().repositories;
      if (!repositories) {
        vscode.window.showInformationMessage('No Git repositories found')
        return exit();
      }

      let repository;
      const multipleRepositories = repositories.length > 1;
      if (multipleRepositories){
        const items = repositories.map(repo => ({
          label: path.basename(repo.rootUri.fsPath),
          description: repo.state.HEAD?.name || '',
          repository: repo
        }));
        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a repository',
        });
        if (!selected) return exit(); // exit on 'esc'
        repository = selected.repository;
      } else { // only one repository
        repository = repositories.pop();
      }

      const {stagedChanges, unstagedChanges}= getChanges()
      if (unstagedChanges.length === 0 && stagedChanges.length === 0) {
        vscode.window.showInformationMessage("No Changes");
        return exit(); // no changes. exit.
      }

      // |-------------------------------|
      // |        all systems go!        |
      // |-------------------------------|

      if (
        vscode.workspace.getConfiguration(extPrefix).get(KEYS.previewDiff, true)
        && vscode.workspace.getConfiguration(extPrefix).get(KEYS.closeSidebarsOnOpen, true)
      ){
        vscode.commands.executeCommand("workbench.action.closeSidebar");
        vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
        vscode.commands.executeCommand("workbench.action.closePanel");
      }

      repoEventListener = repository.state.onDidChange(()=>{
        if (stageFilePicker){
          if (stageFilePicker.ignoreFocusOut){stageFilePicker.ignoreFocusOut=false}
          const { stagedChanges, unstagedChanges} = getChanges()
          if (
            stagedChanges.length !== stageFilePicker.stagedChanges.length ||
            unstagedChanges.length !== stageFilePicker.unstagedChanges.length
          ) {
            if (updateTimer){
              clearTimeout(updateTimer)
            }
            updateTimer = setTimeout(() => {
              const index = stageFilePicker.selectionIndex
              stageFilePicker.updateItems(index ? index : 0);
              stageFilePicker.selectionIndex = null
            }, 50);
          }
        }
      })

      //   Create Picker
      // -----------------

      stageFilePicker = vscode.window.createQuickPick();
      stageFilePicker.keepScrollPosition = true;
      stageFilePicker.placeholder = "Select a file to Stage or Unstage ...";
      stageFilePicker.repository = repository
      stageFilePicker.multipleRepositories = multipleRepositories
      stageFilePicker.stagedChanges = stagedChanges
      stageFilePicker.unstagedChanges = unstagedChanges
      stageFilePicker.onDidTriggerItemButton(({button, item}) => button.trigger(item))


      //   Update UI
      // -------------

      stageFilePicker.updateItems = (index=0) => {
        // reset typed input
        stageFilePicker.value = "";

        const { stagedChanges, unstagedChanges } = getChanges()
        // changes might be discarded...
        if (unstagedChanges.length === 0 && stagedChanges.length === 0) {
          return exit(); // no changes. exit.
        }
        // update changes cache
        stageFilePicker.stagedChanges = stagedChanges
        stageFilePicker.unstagedChanges = unstagedChanges

        // create quickPick items
        const stagedItems = stagedChanges.map(createQuickPickItem);
        const unstagedItems = unstagedChanges.map(createQuickPickItem);

        const stageAllItem = {
          description: `      Stage All Changes (${
            isMacOS ? "⌘⇧S" : "Shift+Ctrl+S"
          })`,
          command: COMMANDS.stageAll,
        };
        const unstageAllItem = {
          description: `      Unstage All Changes (${
            isMacOS ? "⌘⇧U" : "Shift+Ctrl+U"
          })`,
          command: COMMANDS.unstageAll,
        };

        const unstagedChangesGroup = [];
        if (stagedChanges.length > 0) {
          unstagedChangesGroup.push(unstageAllItem);
        }
        unstagedChangesGroup.push({
          // separator
          label: `Changes (${unstagedChanges.length})`,
          kind: vscode.QuickPickItemKind.Separator,
        });
        unstagedChangesGroup.push(...unstagedItems);

        const stagedChangesGroup = [];
        if (unstagedChanges.length > 0) {
          stagedChangesGroup.push(stageAllItem);
        }
        stagedChangesGroup.push({
          // separator
          label: `Staged Changes (${stagedChanges.length})`,
          kind: vscode.QuickPickItemKind.Separator,
        });
        stagedChangesGroup.push(...stagedItems);

        stageFilePicker.items = [
          ...stagedChangesGroup,
          ...unstagedChangesGroup,
        ];

        //   set active item
        // -------------------
        while (
          index >= stageFilePicker.items.length ||
          stageFilePicker.items[index].command === COMMANDS.unstageAll
        ) {index--};
        while (
          stageFilePicker.items[index].command === COMMANDS.stageAll ||
          stageFilePicker.items[index].kind === vscode.QuickPickItemKind.Separator
        ) {index++};
        stageFilePicker.activeItems = [stageFilePicker.items[index]];
      };

      stageFilePicker.updateItems();
      stageFilePicker.show();



      // |-----------------------------|
      // |        Functionality        |
      // |-----------------------------|

      function getChanges() {
        return {
          unstagedChanges: repository.state.workingTreeChanges,
          stagedChanges: repository.state.indexChanges,
        };
      }

      function createQuickPickItem(resource) {
        const filepath = resource.uri.fsPath;
        let directory = path.relative(repository.rootUri.fsPath, path.dirname(resource.uri.fsPath));
        if (directory !== "") directory = `${directory}${path.sep}`;
        const file = path.basename(filepath);
        const isStaged =  resource.status < 5;
        const stageSymbol = isStaged ? "diff-remove" : "diff-insert";
        const statusSymbol = STATUS_SYMBOLS[resource.status]
        const label = `$(${stageSymbol}) ${file}`;
        const description = `     ${statusSymbol ? statusSymbol : " "}     ${directory}`;

        let buttons = []
        // add discard changes only for unstaged files
        if (!isStaged){
          // discard Changes
          buttons.push({
            iconPath: new vscode.ThemeIcon("discard"),
            tooltip: "Discard Changes (Delete)",
            trigger: () => {
              vscode.commands.executeCommand(COMMANDS.discardChanges)
            }
          })
        }
        buttons = [
          ...buttons,
          // go to file
          {
            iconPath: new vscode.ThemeIcon("go-to-file"),
            tooltip: `Open File (${isMacOS ? "⌘O" : "Ctrl+O"})`,
            trigger: (selection) => {
              stageFilePicker.openFile(selection)
            }
          },
          // toggle stage
          {
            iconPath: new vscode.ThemeIcon(stageSymbol),
            tooltip: `${isStaged ? "Unstage" : "Stage"} File (Enter)`,
            trigger: (selection) => {
              stageFilePicker.toggleStage(selection)
            }
          },
        ]
        return {
          label,
          description,
          resource,
          buttons,
        };
      }

      //   Stage File
      // --------------

      stageFilePicker.toggleStage = async (selection) => {
        const isStaged = selection.resource.status < 5
        if (isStaged){
          vscode.commands.executeCommand("git.unstage",selection.resource.uri)
        }else{
          vscode.commands.executeCommand("git.stage",selection.resource.uri)
        }

        let selectionIndex = stageFilePicker.items.findIndex(
          (item) => item.resource && item.resource.uri.fsPath === selection.resource.uri.fsPath
        );

        // if staging a file, move the index to the next item
        if (!isStaged){
          selectionIndex++;
        }

        // if the "unstageAll item" is added to the list
        // the desired target item is pushed down by one index
        if (stageFilePicker.stagedChanges.length === 0) {
          selectionIndex++;
        }

        // store the selectionIndex for use in repoEventListener()
        stageFilePicker.selectionIndex = selectionIndex
      }

      fileWasOpened = false;

      //   Discard File
      // ----------------

      stageFilePicker.discardFile = (selection) => {
        cp.exec(
          `git restore "${selection.resource.uri.fsPath}"`,
          { cwd: repository.rootUri.fsPath }
        );
      }

      //   Open File
      // -------------

      stageFilePicker.openFile = (selection) => {
        fileWasOpened = true
        vscode.commands.executeCommand("vscode.open", selection.resource.uri, { preview: false});
      }

      //   Diff File
      // -------------

      stageFilePicker.diffFile = (selection, options={}) => {

      // thanks @anatolytimonin and @dannypernik for all your help here!

        const fileUri = selection.resource.uri;
        if (selection.resource.status === 1 || selection.resource.status === 7) {
          vscode.commands.executeCommand(
            "vscode.open",
            fileUri,
            options
          );
        } else {
          const headFileUri = fileUri.with({
            scheme: 'git',
            query: JSON.stringify({
              path: fileUri.fsPath,
              ref: 'HEAD'
            })
          });

          vscode.commands.executeCommand(
            "vscode.diff",
            headFileUri,
            selection.resource.uri,
            '',
            options
          );
        }
      }

      // |------------------------------|
      // |        Input Handling        |
      // |------------------------------|

      //   on Arrow Keys
      // -----------------

      stageFilePicker.onDidChangeActive(([selection]) => {
        // preview the diff for the selected file
        if (!selection) return;
        if (vscode.workspace.getConfiguration(extPrefix).get(KEYS.previewDiff, true) && selection.resource){
          stageFilePicker.diffFile(selection,{
              preview: true,
              preserveFocus: true
          });
        }
      });

      //   on Enter
      // ------------

      // these are both called on 'enter' when .canSelectMany is false
      // except .onDidAccept() is not passed .activeItems as params

      // stageFilePicker.onDidAccept();
      stageFilePicker.onDidChangeSelection(([selection]) => {
        if (selection) {
          switch (selection.command) {
            case COMMANDS.stageAll: // selection was stageAll
              vscode.commands.executeCommand(COMMANDS.stageAll);
              break;
            case COMMANDS.unstageAll: // selection was unstageAll
              vscode.commands.executeCommand(COMMANDS.unstageAll);
              break;
            default: // selection was a file
              stageFilePicker.toggleStage(selection)
            break;
          }
        }
      });

      //   on Esc
      // ----------

      stageFilePicker.onDidHide(() => {
        exit();

        if (vscode.workspace.getConfiguration(extPrefix).get(KEYS.closePreviewOnExit, true)){
          const tabs = vscode.window.tabGroups.activeTabGroup.tabs
          tabs.forEach((tab) => {
            if (tab.isPreview){
              vscode.window.tabGroups.close(tab);
            }
          })
        }

        if (!fileWasOpened && vscode.workspace.getConfiguration(extPrefix).get(KEYS.focusScmSidebarOnExit, true)){
          vscode.commands.executeCommand("workbench.scm.focus");
        }
      })

    }),

    //   on Space
    // ------------

    vscode.commands.registerCommand(COMMANDS.openDiff, () => {
      if (stageFilePicker) {
        const [selection] = stageFilePicker.activeItems
        if (selection){
          switch (selection.command) {
            case COMMANDS.stageAll:
              return; // do nothing
            case COMMANDS.unstageAll:
              return; // do nothing
            default:
              fileWasOpened = true
              stageFilePicker.diffFile(selection,
                {
                  preview: false,
                  preserveFocus: !vscode.workspace.getConfiguration(extPrefix).get(KEYS.passFocusOnOpenDiff, false),
                });
            break;
          }
        }
      }
    }),

    //   Scroll Commands
    // -------------------

    //  ctrl+left => jump to previous changed range (10 lines before)
    vscode.commands.registerCommand(COMMANDS.scrollPrevChange, async () => {
      if (stageFilePicker && vscode.workspace.getConfiguration(extPrefix).get(KEYS.previewDiff, true)) {
        const editor = vscode.window.activeTextEditor;
        await jumpToChange(editor, 'prev');
      }
    }),
    //  ctrl+right => jump to next changed range (10 lines before)
    vscode.commands.registerCommand(COMMANDS.scrollNextChange, async () => {
      if (stageFilePicker && vscode.workspace.getConfiguration(extPrefix).get(KEYS.previewDiff, true)) {
        const editor = vscode.window.activeTextEditor;
        await jumpToChange(editor, 'next');
      }
    }),
    // ctrl+up => scroll up
    vscode.commands.registerCommand(COMMANDS.scrollUp, () => {
      if (stageFilePicker && vscode.workspace.getConfiguration(extPrefix).get(KEYS.previewDiff, true)) {
        vscode.commands.executeCommand("editorScroll",{ to: "up", by: "page"})
      }
    }),
    // ctrl+down => scroll down
    vscode.commands.registerCommand(COMMANDS.scrollDown, () => {
      if (stageFilePicker && vscode.workspace.getConfiguration(extPrefix).get(KEYS.previewDiff, true)) {
        vscode.commands.executeCommand("editorScroll",{ to: "down", by: "page"})
      }
    }),
    vscode.commands.registerCommand(COMMANDS.scrollLeft, () => {
      if (stageFilePicker && vscode.workspace.getConfiguration(extPrefix).get(KEYS.previewDiff, true)) {
        vscode.commands.executeCommand("scrollLeft")
      }
    }),
    vscode.commands.registerCommand(COMMANDS.scrollRight, () => {
      if (stageFilePicker && vscode.workspace.getConfiguration(extPrefix).get(KEYS.previewDiff, true)) {
        vscode.commands.executeCommand("scrollRight")
      }
    }),

    //   on Delete
    // -------------

    vscode.commands.registerCommand(COMMANDS.discardChanges, () => {
      if (stageFilePicker){
        stageFilePicker.ignoreFocusOut = true;
        const [selection] = stageFilePicker.activeItems;
        if (selection){
          switch (selection.command) {
            case COMMANDS.stageAll:
              return; // do nothing
            case COMMANDS.unstageAll:
              return; // do nothing
            default:
              stageFilePicker.discardFile(selection)
            break;
          }
        }
      }
    }),

    vscode.commands.registerCommand(COMMANDS.openFile, () => {
      if (stageFilePicker){
        stageFilePicker.ignoreFocusOut = false;
        const [selection] = stageFilePicker.activeItems;
        if (selection){
          switch (selection.command) {
            case COMMANDS.stageAll:
              return; // do nothing
            case COMMANDS.unstageAll:
              return; // do nothing
            default:
              stageFilePicker.openFile(selection)
            break;
          }
        }
      }
    }),

    vscode.commands.registerCommand(COMMANDS.stageAll, () => {
      if (stageFilePicker) {
        if (stageFilePicker.multipleRepositories){
          vscode.commands.executeCommand("git.stage", ...stageFilePicker.unstagedChanges.map(item => item.uri));
        } else {
          vscode.commands.executeCommand("git.stageAll");
        }
      }
    }),

    vscode.commands.registerCommand(COMMANDS.unstageAll, () => {
      if (stageFilePicker) {
        if (stageFilePicker.multipleRepositories){
          vscode.commands.executeCommand("git.unstage",...stageFilePicker.stagedChanges.map(item => item.uri));
        } else {
          vscode.commands.executeCommand("git.unstageAll");
        }
      }
    }),
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
