import Set from 'mobiledoc-kit/utils/set';
import { forEach, filter } from 'mobiledoc-kit/utils/array-utils';
import assert from 'mobiledoc-kit/utils/assert';
import { containsNode } from 'mobiledoc-kit/utils/dom-utils';

const MUTATION = {
  NODES_CHANGED: 'childList',
  CHARACTER_DATA: 'characterData'
};

function DummyMutationObserver () {}
DummyMutationObserver.prototype.observe = function () {};
DummyMutationObserver.prototype.disconnect = function () {};

export default class MutationHandler {
  constructor(editor) {
    this.editor     = editor;
    this.logger     = editor.loggerFor('mutation-handler');
    this.renderTree = null;
    this._isObserving = false;


    if (typeof MutationObserver !== 'undefined') {
      this._observer = new MutationObserver((mutations) => {
        this._handleMutations(mutations);
      });
    } else {
      // Use dummy for SSR etc.
      this._observer = new DummyMutationObserver();
    }
  }

  init() {
    this.startObserving();
  }

  destroy() {
    this.stopObserving();
    this._observer = null;
  }

  suspendObservation(callback) {
    this.stopObserving();
    callback();
    this.startObserving();
  }

  stopObserving() {
    if (this._isObserving) {
      this._isObserving = false;
      this._observer.disconnect();
    }
  }

  startObserving() {
    if (!this._isObserving) {
      let { editor } = this;
      assert('Cannot observe un-rendered editor', editor.hasRendered);

      this._isObserving = true;
      this.renderTree = editor._renderTree;

      this._observer.observe(editor.element, {
        characterData: true,
        childList: true,
        subtree: true
      });
    }
  }

  reparsePost() {
    this.editor._reparsePost();
  }

  reparseSections(sections) {
    this.editor._reparseSections(sections);
  }

  /**
   * for each mutation:
   *   * find the target nodes:
   *     * if nodes changed, target nodes are:
   *        * added nodes
   *        * the target from which removed nodes were removed
   *     * if character data changed
   *       * target node is the mutation event's target (text node)
   *     * filter out nodes that are no longer attached (parentNode is null)
   *   * for each remaining node:
   *   *  find its section, add to sections-to-reparse
   *   *  if no section, reparse all (and break)
   */
  _handleMutations(mutations) {
    let reparsePost = false;
    let sections = new Set();

    // This is a hack so we don't get lots of didUpdate events when checking cursor position
    // by adding and removing a tag at caret position.
    let noRealChange;

    let tmpM = mutations.reduce((prev, curr) => {
      for (let i = 0; i < prev.length; i++) {
        let tmp = prev[i];
        if (tmp.target === curr.target) {
          tmp.addedNodes = tmp.addedNodes.concat(Array.from(curr.addedNodes).map((a) => a.outerHTML));
          tmp.removedNodes = tmp.removedNodes.concat(Array.from(curr.removedNodes).map((a) => a.outerHTML));
          return prev;
        }
      }
      prev.push({
        target: curr.target,
        addedNodes: Array.from(curr.addedNodes).map((a) => a.outerHTML),
        removedNodes: Array.from(curr.removedNodes).map((a) => a.outerHTML)
      });
      return prev;
    }, []);
    tmpM = tmpM.filter((item) => {
      let tmpRem = item.removedNodes;
      const delta = item.addedNodes.reduce((prev, curr) => {
        let foundMatch = false;
        tmpRem = tmpRem.filter((rem) => {
          if (!foundMatch && curr === rem) {
            foundMatch = true;
            return false;
          }
          return true;
        });
        return foundMatch ? prev : prev + 1;
      }, 0);
      // If we have any removes left we add them to indicate a change will happen
      return delta + tmpRem.length;
    });
    noRealChange = tmpM.length === 0;
    // End hack
    

    for (let i = 0; i < mutations.length; i++) {
      if (reparsePost) {
        break;
      }

      let nodes = this._findTargetNodes(mutations[i]);

      for (let j=0; j < nodes.length; j++) {
        let node = nodes[j];
        let renderNode = this._findRenderNodeFromNode(node);
        if (renderNode) {
          if (renderNode.reparsesMutationOfChildNode(node)) {
            let section = this._findSectionFromRenderNode(renderNode);
            if (section) {
              sections.add(section);
            } else {
              reparsePost = true;
            }
          }
        } else {
          reparsePost = true;
          break;
        }
      }
    }

    if (reparsePost) {
      this.logger.log(`reparsePost (${mutations.length} mutations)`);
      this.reparsePost();
    } else if (sections.length) {
      // Don't reparse if there weren't any changes. It causes exessive calls to update
      // and deestroys the undo history by causing lots of snapshots
      if (!noRealChange) {
        this.logger.log(`reparse ${sections.length} sections (${mutations.length} mutations)`);
        this.reparseSections(sections.toArray());
      }
    }
  }

  _findTargetNodes(mutation) {
    let nodes = [];

    switch (mutation.type) {
      case MUTATION.CHARACTER_DATA:
        nodes.push(mutation.target);
        break;
      case MUTATION.NODES_CHANGED:
        forEach(mutation.addedNodes, n => nodes.push(n));
        if (mutation.removedNodes.length) {
          nodes.push(mutation.target);
        }
        break;
    }

    let element = this.editor.element;
    let attachedNodes = filter(nodes, node => containsNode(element, node));
    return attachedNodes;
  }

  _findSectionRenderNodeFromNode(node) {
    return this.renderTree.findRenderNodeFromElement(node, (rn) => {
      return rn.postNode.isSection;
    });
  }

  _findRenderNodeFromNode(node) {
    return this.renderTree.findRenderNodeFromElement(node);
  }

  _findSectionFromRenderNode(renderNode) {
    let sectionRenderNode = this._findSectionRenderNodeFromNode(renderNode.element);
    return sectionRenderNode && sectionRenderNode.postNode;
  }

}
