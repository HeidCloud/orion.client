/*******************************************************************************
 * @license
 * Copyright (c) 2013 IBM Corporation and others. 
 * All rights reserved. This program and the accompanying materials are made 
 * available under the terms of the Eclipse Public License v1.0 
 * (http://www.eclipse.org/legal/epl-v10.html), and the Eclipse Distribution 
 * License v1.0 (http://www.eclipse.org/org/documents/edl-v10.html). 
 * 
 * Contributors: IBM Corporation - initial API and implementation
 ******************************************************************************/
/*global define URL*/
/*jslint browser:true sub:true*/
define([
	'i18n!orion/edit/nls/messages',
	'orion/objects',
	'orion/webui/littlelib',
	'orion/explorers/explorer-table',
	'orion/explorers/navigatorRenderer',
	'orion/explorers/explorerNavHandler',
	'orion/keyBinding',
	'orion/fileCommands',
	'orion/extensionCommands',
	'orion/selection',
	'orion/URITemplate',
	'orion/PageUtil',
	'orion/Deferred'
], function(
	messages, objects, lib, mExplorer, mNavigatorRenderer, mExplorerNavHandler, mKeyBinding,
	FileCommands, ExtensionCommands, Selection, URITemplate, PageUtil, Deferred
) {
	var FileExplorer = mExplorer.FileExplorer;
	var KeyBinding = mKeyBinding.KeyBinding;
	var NavigatorRenderer = mNavigatorRenderer.NavigatorRenderer;

	var uriTemplate = new URITemplate("#{,resource,params*}"); //$NON-NLS-0$

	/**
	 * @class orion.sidebar.CommonNavExplorer
	 * @extends orion.explorers.FileExplorer
	 */
	function CommonNavExplorer(params) {
		params.setFocus = false;   // do not steal focus on load
		params.cachePrefix = null; // do not persist table state
		params.modelEventDispatcher = FileCommands.getModelEventDispatcher();
		params.dragAndDrop = FileCommands.uploadFile;
		FileExplorer.apply(this, arguments);
		this.commandRegistry = params.commandRegistry;
		this.editorInputManager = params.editorInputManager;
		this.progressService = params.progressService;
		var sidebarNavInputManager = this.sidebarNavInputManager = params.sidebarNavInputManager;
		this.toolbarNode = params.toolbarNode;
		this.newActionsScope = this.toolbarNode.id + "New"; //$NON-NLS-0$
		this.selectionActionsScope = this.toolbarNode.id + "Selection"; //$NON-NLS-0$
		this.folderNavActionsScope = this.toolbarNode.id + "Folder"; //$NON-NLS-0$

		this.treeRoot = {}; // Needed by FileExplorer.prototype.loadResourceList
		var _self = this;
		this.editorInputListener = function(event) {
			_self.reveal(event.metadata, true);
		};
		this.editorInputManager.addEventListener("InputChanged", this.editorInputListener); //$NON-NLS-0$
		var dispatcher = this.modelEventDispatcher;
		var onChange = this._modelListener = this.onFileModelChange.bind(this);
		["move", "delete"].forEach(function(type) { //$NON-NLS-1$ //$NON-NLS-0$
			dispatcher.addEventListener(type, onChange);
		});
		this.selection = new Selection.Selection(this.registry, "commonNavFileSelection"); //$NON-NLS-0$
		this._selectionListener = function(event) { //$NON-NLS-0$
			_self.updateCommands(event.selections);
			if (sidebarNavInputManager) {
				_self.sidebarNavInputManager.dispatchEvent(event);
			}
		};
		this.selection.addEventListener("selectionChanged", this._selectionListener); //$NON-NLS-0$
		this.commandsRegistered = this.registerCommands();
	}
	CommonNavExplorer.prototype = Object.create(FileExplorer.prototype);
	objects.mixin(CommonNavExplorer.prototype, /** @lends orion.sidebar.CommonNavExplorer.prototype */ {
		onFileModelChange: function(event) {
			var oldValue = event.oldValue, newValue = event.newValue;
			// Detect if we moved/renamed/deleted the current file being edited, or an ancestor thereof.
			var editorFile = this.editorInputManager.getFileMetadata();
			if (!editorFile) {
				return;
			}
			var affectedAncestor;
			[editorFile].concat(editorFile.Parents || []).some(function(ancestor) {
				if (oldValue.Location === ancestor.Location) {
					affectedAncestor = oldValue;
					return true;
				}
				return false;
			});
			if (affectedAncestor) {
				var newInput;
				if (affectedAncestor.Location === editorFile.Location) {
					// Current file was the target, see if we know its new name
					newInput = (newValue && newValue.ChildrenLocation) || (newValue && newValue.ContentLocation) || (newValue && newValue.Location) || null;
				} else {
					newInput = null;
				}
				this.sidebarNavInputManager.dispatchEvent({
					type: "editorInputMoved", //$NON-NLS-0$
					parent: this.treeRoot.ChildrenLocation,
					newInput: newInput
				});
			}
		},
		createActionSections: function() {
			var _self = this;
			// Create some elements that we can hang actions on. Ideally we'd have just 1, but the
			// CommandRegistry seems to require dropdowns to have their own element.
			[this.newActionsScope, this.selectionActionsScope, this.folderNavActionsScope].forEach(function(id) {
				if (!_self[id]) {
					var elem = document.createElement("ul"); //$NON-NLS-0$
					elem.id = id;
					elem.classList.add("commandList"); //$NON-NLS-0$
					elem.classList.add("layoutLeft"); //$NON-NLS-0$
					elem.classList.add("pageActions"); //$NON-NLS-0$
					_self.toolbarNode.appendChild(elem);
					_self[id] = elem;
				}
			});
		},
		destroy: function() {
			var _self = this;
			var dispatcher = this.modelEventDispatcher;
			["move", "delete"].forEach(function(type) { //$NON-NLS-1$ //$NON-NLS-0$
				dispatcher.removeEventListener(type, _self._modelListener);
			});
			FileExplorer.prototype.destroy.call(this);
			[this.newActionsScope, this.selectionActionsScope, this.folderNavActionsScope].forEach(function(id) {
				delete _self[id];
			});
			this.editorInputManager.removeEventListener("InputChanged", this.editorInputListener); //$NON-NLS-0$
			this.selection.removeEventListener("selectionChanged", this._selectionListener); //$NON-NLS-0$
		},
		display: function(root, force) {
			this.loadRoot(root, force).then(function(){
				this.updateCommands();
				this.reveal(this.editorInputManager.getFileMetadata(), true);
			}.bind(this));	
		},
		expandToItem: function(item, afterExpand) {
			if(!item || !this.model) {
				return;
			}
			var itemId = this.model.getId(item);
			var itemNode = lib.node(itemId);
			if(itemNode){
				if(this.myTree.isExpanded(item)) {
					afterExpand();
				} else {
					this.myTree.expand(itemId, afterExpand);
				}
			} else if(item.Parents && item.Parents.length>0) {
				item.Parents[0].Parents = item.Parents.slice(1);
				this.expandToItem(item.Parents[0], function(){
					this.myTree.expand(itemId, afterExpand);					
				}.bind(this));
			}
		},
		/**
		 * Loads the given children location as the root.
		 * @param {String|Object} The childrenLocation or an object with a ChildrenLocation field.
		 */
		loadRoot: function(childrenLocation, force) {
			childrenLocation = (childrenLocation && childrenLocation.ChildrenLocation) || childrenLocation || ""; //$NON-NLS-0$
			return this.commandsRegistered.then(function() {
				if (childrenLocation && typeof childrenLocation === "object") { //$NON-NLS-0$
					return this.load(childrenLocation);
				} else {
					return this.loadResourceList(childrenLocation, force);
				}
			}.bind(this));
		},
		reveal: function(fileMetadata, expand) {
			if (!fileMetadata) {
				return;
			}
			if (!expand) {
				var navHandler = this.getNavHandler();
				if (navHandler) {
					var row = this.getRow(fileMetadata);
					if (row) {
						fileMetadata = row._item;
					}
					if (fileMetadata.Location === this.treeRoot.Location && fileMetadata.Children && fileMetadata.Children.length) {
						fileMetadata = fileMetadata.Children[0];
					}
					navHandler.cursorOn(fileMetadata, true);
					navHandler.setSelection(fileMetadata);
				}
				return;
			}
			var expandFunc = function() {
				this.expandToItem(fileMetadata, function(){
					this.reveal(fileMetadata);
				}.bind(this));
			}.bind(this);
			if (this.fileInCurrentTree(fileMetadata)) {
				var outOfSync = this.outOfSync(fileMetadata);
				if (outOfSync) {
					this.changedItem(outOfSync, true).then(expandFunc);
				} else {
					expandFunc();
				}
			} else if (!PageUtil.matchResourceParameters().navigate) {
				this.loadRoot(this.fileClient.fileServiceRootURL(fileMetadata.Location)).then(expandFunc);
			}
		},
		outOfSync: function(fileMetadata) {
			// Determines whether the cached children is out of date since it does not contain the specified file/folder.
			var treeRoot = this.treeRoot;
			var metadatas = [];
			if (fileMetadata && fileMetadata.Parents && treeRoot && treeRoot.Location) {
				for (var i=0; i<fileMetadata.Parents.length; i++) {
					if (fileMetadata.Parents[i].Location === treeRoot.Location) {
						break;
					}
					metadatas.push(fileMetadata.Parents[i]);
				}
			}
			metadatas.reverse();
			metadatas.push(fileMetadata);
			var temp = treeRoot;
			for (var j=0; j<metadatas.length && temp; j++) {
				var children = temp.children;
				if (children) {
					var found = false;
					for (var k=0; k<children.length; k++) {
						if (children[k].Location === metadatas[j].Location) {
							temp = children[k];
							found = true;
							break;
						}
					}
					if (!found) {
						return temp;
					}
				} else {
					break;
				}
			}
			return null;
		},
		scope: function(childrenLocation) {
			childrenLocation = (childrenLocation && childrenLocation.ChildrenLocation) || childrenLocation || ""; //$NON-NLS-0$
			var params = PageUtil.matchResourceParameters();
			var resource = params.resource;
			params.navigate = childrenLocation;
			delete params.resource;
			window.location.href = uriTemplate.expand({resource: resource, params: params});
		},
		scopeUp: function() {
			var navigate;
			var root = this.treeRoot;
			var parent = root.Parents && root.Parents[0];
			if (parent) {
				navigate = parent.ChildrenLocation;
			} else {
				navigate = this.fileClient.fileServiceRootURL(root.Location);
			}
			this.scope(navigate);
		},
		scopeDown: function(item) {
			this.scope(item.ChildrenLocation);
		},
		fileInCurrentTree: function(fileMetadata) {
			var fileClient = this.fileClient, treeRoot = this.treeRoot;
			if (treeRoot && fileClient.fileServiceRootURL(fileMetadata.Location) !== fileClient.fileServiceRootURL(treeRoot.Location)) {
				return false;
			}
			// Already at the workspace root?
			if (!treeRoot.Parents) { return true; }
			if (fileMetadata && fileMetadata.Parents && treeRoot && treeRoot.Location) {
				for (var i=0; i<fileMetadata.Parents.length; i++) {
					if (fileMetadata.Parents[i].Location === treeRoot.Location) {
						return true;
					}
				}
			}
			return false;
		},
		// Returns a deferred that completes once file command extensions have been processed
		registerCommands: function() {
			var commandRegistry = this.commandRegistry, fileClient = this.fileClient, serviceRegistry = this.registry;
			var newActionsScope = this.newActionsScope;
			var selectionActionsScope = this.selectionActionsScope;
			var folderNavActionsScope = this.folderNavActionsScope;
			commandRegistry.addCommandGroup(newActionsScope, "orion.commonNavNewGroup", 1000, messages["New"], null, null, "core-sprite-addcontent", null, "dropdownSelection"); //$NON-NLS-3$ //$NON-NLS-2$ //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.addCommandGroup(selectionActionsScope, "orion.commonNavSelectionGroup", 100, messages["Actions"], null, null, "core-sprite-gear", null, "dropdownSelection"); //$NON-NLS-3$ //$NON-NLS-2$ //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerSelectionService(selectionActionsScope, this.selection);

			var renameBinding = new KeyBinding(113); // F2
			var delBinding = new KeyBinding(46); // Delete
			var copySelections = new KeyBinding('c', true); /* Ctrl+C */ //$NON-NLS-0$
			var pasteSelections = new KeyBinding('v', true); /* Ctrl+V */ //$NON-NLS-0$
			var upFolder = new KeyBinding(38, false, false, true); /* Alt+UpArrow */
			var downFolder = new KeyBinding(40, false, false, true); /* Alt+DownArrow */
			downFolder.domScope = upFolder.domScope = pasteSelections.domScope = copySelections.domScope = delBinding.domScope = renameBinding.domScope = "sidebar"; //$NON-NLS-0$
			downFolder.scopeName = upFolder.scopeName = pasteSelections.scopeName = copySelections.scopeName = delBinding.scopeName = renameBinding.scopeName = messages.Navigator; //$NON-NLS-0$

			// commands that don't appear but have keybindings
			commandRegistry.registerCommandContribution(newActionsScope, "eclipse.copySelections", 1, null, true, copySelections); //$NON-NLS-0$
			commandRegistry.registerCommandContribution(newActionsScope, "eclipse.pasteSelections", 1, null, true, pasteSelections); //$NON-NLS-0$

			// New file and new folder (in a group)
			commandRegistry.registerCommandContribution(newActionsScope, "eclipse.newFile", 1, "orion.commonNavNewGroup/orion.newContentGroup"); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(newActionsScope, "eclipse.newFolder", 2, "orion.commonNavNewGroup/orion.newContentGroup", false, null/*, new mCommandRegistry.URLBinding("newFolder", "name")*/); //$NON-NLS-3$ //$NON-NLS-2$ //$NON-NLS-1$ //$NON-NLS-0$
			// New project creation in the toolbar (in a group)
			commandRegistry.registerCommandContribution(newActionsScope, "orion.new.project", 3, "orion.commonNavNewGroup/orion.newContentGroup"); //$NON-NLS-2$ //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(newActionsScope, "orion.new.linkProject", 4, "orion.commonNavNewGroup/orion.newContentGroup"); //$NON-NLS-2$ //$NON-NLS-1$ //$NON-NLS-0$
			// Folder nav actions
			commandRegistry.registerCommandContribution(folderNavActionsScope, "eclipse.upFolder", 1, null, false, upFolder); //$NON-NLS-0$
			
			commandRegistry.registerCommandContribution(selectionActionsScope, "eclipse.downFolder", 1, "orion.commonNavSelectionGroup", false, downFolder); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(selectionActionsScope, "eclipse.renameResource", 2, "orion.commonNavSelectionGroup", false, renameBinding); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(selectionActionsScope, "eclipse.copyFile", 3, "orion.commonNavSelectionGroup"); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(selectionActionsScope, "eclipse.moveFile", 4, "orion.commonNavSelectionGroup"); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(selectionActionsScope, "eclipse.deleteFile", 5, "orion.commonNavSelectionGroup", false, delBinding); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(selectionActionsScope, "eclipse.compareWithEachOther", 6, "orion.commonNavSelectionGroup");  //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(selectionActionsScope, "eclipse.compareWith", 7, "orion.commonNavSelectionGroup");  //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(selectionActionsScope, "orion.importZipURL", 1, "orion.commonNavSelectionGroup/orion.importExportGroup"); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(selectionActionsScope, "orion.import", 2, "orion.commonNavSelectionGroup/orion.importExportGroup"); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(selectionActionsScope, "eclipse.downloadFile", 3, "orion.commonNavSelectionGroup/orion.importExportGroup"); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(selectionActionsScope, "orion.importSFTP", 4, "orion.commonNavSelectionGroup/orion.importExportGroup"); //$NON-NLS-1$ //$NON-NLS-0$
			commandRegistry.registerCommandContribution(selectionActionsScope, "eclipse.exportSFTPCommand", 5, "orion.commonNavSelectionGroup/orion.importExportGroup"); //$NON-NLS-1$ //$NON-NLS-0$
			FileCommands.createFileCommands(serviceRegistry, commandRegistry, this, fileClient);
			return ExtensionCommands.createAndPlaceFileCommandsExtension(serviceRegistry, commandRegistry, selectionActionsScope, 0, "orion.commonNavSelectionGroup", true); //$NON-NLS-0$
		},
		updateCommands: function(selections) {
			this.createActionSections();
			var selectionTools = this.selectionActionsScope;
			var treeRoot = this.treeRoot, commandRegistry = this.commandRegistry;
			FileCommands.updateNavTools(this.registry, commandRegistry, this, this.newActionsScope, selectionTools, treeRoot, true);
			commandRegistry.destroy(this.folderNavActionsScope);
			commandRegistry.renderCommands(this.folderNavActionsScope, this.folderNavActionsScope, this.treeRoot, this, "tool"); //$NON-NLS-0$
		}
	});

	function CommonNavRenderer() {
		NavigatorRenderer.apply(this, arguments);
	}
	CommonNavRenderer.prototype = Object.create(NavigatorRenderer.prototype);
	objects.mixin(CommonNavRenderer.prototype, {
		showFolderLinks: true,
		oneColumn: true,
		createFolderNode: function(folder) {
			var folderNode = NavigatorRenderer.prototype.createFolderNode.call(this, folder);
			if (this.showFolderLinks && folderNode.tagName === "A") { //$NON-NLS-0$
				folderNode.href = uriTemplate.expand({resource: folder.Location});
				folderNode.classList.add("commonNavFolder"); //$NON-NLS-0$
				// TODO wasteful. Should attach 1 listener to parent element, then get folder model item from nav handler
				folderNode.addEventListener("click", this.toggleFolderExpansionState.bind(this, folder, false)); //$NON-NLS-0$
			} else {
				folderNode.classList.add("nav_fakelink"); //$NON-NLS-0$
			}
			return folderNode;
		},
		emptyCallback: function() {
		},
		/**
		 * @param {Object} folder
		 * @param {Boolean} preventDefault
		 * @param {Event} evt
		 */
		toggleFolderExpansionState: function(folder, preventDefault, evt) {
			var navHandler = this.explorer.getNavHandler();
			if (!navHandler) {
				return;
			}
			navHandler.cursorOn(folder);
			navHandler.setSelection(folder, false);
			// now toggle its expand/collapse state
			var curModel = navHandler._modelIterator.cursor();
			if (navHandler.isExpandable(curModel)){
				if (!navHandler.isExpanded(curModel)){
						this.explorer.myTree.expand(curModel);
				} else {
						this.explorer.myTree.collapse(curModel);
				}
				if (preventDefault) {
					evt.preventDefault();
				}
				return false;
			}
		}
	});
	return {
		CommonNavExplorer: CommonNavExplorer,
		CommonNavRenderer: CommonNavRenderer
	};
});