import './MailboxWebView.less'
import PropTypes from 'prop-types'
import React from 'react'
import { RaisedButton, FontIcon } from 'material-ui'
import { mailboxStore, mailboxActions, mailboxDispatch, ServiceReducer } from 'stores/mailbox'
import { guestActions } from 'stores/guest'
import BrowserView from 'sharedui/Components/BrowserView'
import CoreService from 'shared/Models/Accounts/CoreService'
import MailboxSearch from './MailboxSearch'
import MailboxTargetUrl from './MailboxTargetUrl'
import MailboxLoadBar from './MailboxLoadBar'
import shallowCompare from 'react-addons-shallow-compare'
import URI from 'urijs'
import { NotificationService } from 'Notifications'
import {
  WB_MAILBOXES_WINDOW_WEBVIEW_LIFECYCLE_SLEEP,
  WB_MAILBOXES_WINDOW_WEBVIEW_LIFECYCLE_AWAKEN,
  WB_BROWSER_NOTIFICATION_CLICK,
  WB_BROWSER_NOTIFICATION_PRESENT,
  WB_BROWSER_INJECT_CUSTOM_CONTENT,
  WB_MAILBOXES_WINDOW_MAILBOX_WEBVIEW_ATTACHED,
  WB_BROWSER_ALERT_PRESENT,
  WB_BROWSER_CONFIRM_PRESENT
} from 'shared/ipcEvents'
import { ipcRenderer } from 'electron'
import Spinner from 'sharedui/Components/Activity/Spinner'
import * as Colors from 'material-ui/styles/colors'
import { settingsStore } from 'stores/settings'

const BROWSER_REF = 'browser'

export default class MailboxWebView extends React.Component {
  /* **************************************************************************/
  // Class
  /* **************************************************************************/

  static propTypes = Object.assign({
    mailboxId: PropTypes.string.isRequired,
    serviceType: PropTypes.string.isRequired,
    preload: PropTypes.string,
    hasSearch: PropTypes.bool.isRequired,
    plugHTML5Notifications: PropTypes.bool.isRequired,
    webpreferences: PropTypes.string
  }, BrowserView.REACT_WEBVIEW_EVENTS.reduce((acc, name) => {
    acc[name] = PropTypes.func
    return acc
  }, {}))
  static defaultProps = {
    hasSearch: true,
    plugHTML5Notifications: true
  }
  static WEBVIEW_METHODS = BrowserView.WEBVIEW_METHODS
  static REACT_WEBVIEW_EVENTS = BrowserView.REACT_WEBVIEW_EVENTS

  /* **************************************************************************/
  // Object Lifecycle
  /* **************************************************************************/

  constructor (props) {
    super(props)

    const self = this
    this.constructor.WEBVIEW_METHODS.forEach((m) => {
      if (self[m] !== undefined) { return } // Allow overwriting
      self[m] = function () {
        return self.refs[BROWSER_REF][m].apply(self.refs[BROWSER_REF], Array.from(arguments))
      }
    })
  }

  /* **************************************************************************/
  // Component Lifecycle
  /* **************************************************************************/

  componentDidMount () {
    // Stores
    mailboxStore.listen(this.mailboxesChanged)

    // Handle dispatch events
    mailboxDispatch.on('devtools', this.handleOpenDevTools)
    mailboxDispatch.on('refocus', this.handleRefocus)
    mailboxDispatch.on('reload', this.handleReload)
    mailboxDispatch.addGetter('current-url', this.handleGetCurrentUrl)
    mailboxDispatch.on('navigateBack', this.handleNavigateBack)
    mailboxDispatch.on('navigateForward', this.handleNavigateForward)

    if (!this.state.isActive) {
      if (this.refs[BROWSER_REF]) {
        this.refs[BROWSER_REF].send(WB_MAILBOXES_WINDOW_WEBVIEW_LIFECYCLE_SLEEP, {})
      }
    }
  }

  componentWillUnmount () {
    // Stores
    mailboxStore.unlisten(this.mailboxesChanged)

    // Handle dispatch events
    mailboxDispatch.removeListener('devtools', this.handleOpenDevTools)
    mailboxDispatch.removeListener('refocus', this.handleRefocus)
    mailboxDispatch.removeListener('reload', this.handleReload)
    mailboxDispatch.removeGetter('current-url', this.handleGetCurrentUrl)
    mailboxDispatch.removeListener('navigateBack', this.handleNavigateBack)
    mailboxDispatch.removeListener('navigateForward', this.handleNavigateForward)

    // Update the store
    mailboxActions.deleteWebcontentTabId.defer(this.props.mailboxId, this.props.serviceType)
  }

  componentWillReceiveProps (nextProps) {
    if (this.props.mailboxId !== nextProps.mailboxId || this.props.serviceType !== nextProps.serviceType) {
      this.setState(this.generateState(nextProps))
    }
  }

  /* **************************************************************************/
  // Data lifecycle
  /* **************************************************************************/

  state = this.generateState(this.props)

  /**
  * Generates the state from the given props
  * @param props: the props to use
  * @return state object
  */
  generateState (props) {
    const mailboxState = mailboxStore.getState()
    const mailbox = mailboxState.getMailbox(props.mailboxId)
    const service = mailbox ? mailbox.serviceForType(props.serviceType) : null

    return {
      initialLoadDone: false,
      isLoading: false,
      isCrashed: false,
      focusedUrl: null,
      snapshot: mailboxState.getSnapshot(props.mailboxId, props.serviceType),
      isActive: mailboxState.isActive(props.mailboxId, props.serviceType),
      isSearching: mailboxState.isSearchingMailbox(props.mailboxId, props.serviceType),
      searchTerm: mailboxState.mailboxSearchTerm(props.mailboxId, props.serviceType),
      searchId: mailboxState.mailboxSearchHash(props.mailboxId, props.serviceType),
      isolateMailboxProcesses: settingsStore.getState().launched.app.isolateMailboxProcesses, // does not update
      ...(!mailbox || !service ? {
        mailbox: null,
        service: null,
        baseUrl: 'about:blank',
        restorableUrl: 'about:blank'
      } : {
        mailbox: mailbox,
        service: service,
        baseUrl: service.url,
        restorableUrl: service.restorableUrl
      })
    }
  }

  mailboxesChanged = (mailboxState) => {
    const { mailboxId, serviceType } = this.props
    const mailbox = mailboxState.getMailbox(mailboxId)
    const service = mailbox ? mailbox.serviceForType(serviceType) : null

    if (mailbox && service) {
      this.setState((prevState) => {
        return {
          mailbox: mailbox,
          service: service,
          isActive: mailboxState.isActive(mailboxId, serviceType),
          snapshot: mailboxState.getSnapshot(mailboxId, serviceType),
          isSearching: mailboxState.isSearchingMailbox(mailboxId, serviceType),
          searchTerm: mailboxState.mailboxSearchTerm(mailboxId, serviceType),
          searchId: mailboxState.mailboxSearchHash(mailboxId, serviceType),
          ...(prevState.baseUrl !== service.url ? {
            baseUrl: service.url,
            restorableUrl: service.restorableUrl,
            initialLoadDone: false
          } : {})
        }
      })
    } else {
      this.setState({ mailbox: null, service: null })
    }
  }

  /* **************************************************************************/
  // WebView overwrites
  /* **************************************************************************/

  /**
  * @Pass through to webview.loadURL()
  */
  loadURL = (url) => {
    return this.refs[BROWSER_REF].loadURL(url)
  }

  /**
  * @return the dom node for the webview
  */
  getWebviewNode = () => {
    return this.refs[BROWSER_REF].getWebviewNode()
  }

  /* **************************************************************************/
  // Dispatcher Events
  /* **************************************************************************/

  /**
  * Handles the inspector dispatch event
  * @param evt: the event that fired
  */
  handleOpenDevTools = (evt) => {
    if (evt.mailboxId === this.props.mailboxId) {
      if (!evt.service && this.state.isActive) {
        this.refs[BROWSER_REF].openDevTools()
      } else if (evt.service === this.props.serviceType) {
        this.refs[BROWSER_REF].openDevTools()
      }
    }
  }

  /**
  * Handles refocusing the mailbox
  * @param evt: the event that fired
  */
  handleRefocus = (evt) => {
    if ((!evt.mailboxId || !evt.service) && this.state.isActive) {
      setTimeout(() => { this.refs[BROWSER_REF].focus() })
    } else if (evt.mailboxId === this.props.mailboxId && evt.service === this.props.serviceType) {
      setTimeout(() => { this.refs[BROWSER_REF].focus() })
    }
  }

  /**
  * Handles reloading the mailbox
  * @param evt: the event that fired
  */
  handleReload = (evt) => {
    const { serviceType, mailboxId } = this.props
    const { service, isActive } = this.state

    if (evt.mailboxId === mailboxId) {
      let shouldReload = false

      if (evt.allServices) {
        shouldReload = true
      } else if (!evt.service && isActive) {
        shouldReload = true
      } else if (evt.service === serviceType) {
        shouldReload = true
      }

      if (shouldReload) {
        if (service) {
          if (service.reloadBehaviour === CoreService.RELOAD_BEHAVIOURS.RELOAD) {
            this.reload()
          } else if (service.reloadBehaviour === CoreService.RELOAD_BEHAVIOURS.RESET_URL) {
            this.loadURL(service.url)
          }
        } else {
          this.reload()
        }
      }
    }
  }

  /**
  * Handles getting the current url
  * @param mailboxId: the id of the mailbox
  * @param serviceType: the type of service
  * @return the current url or null if not applicable for use
  */
  handleGetCurrentUrl = ({ mailboxId, serviceType }) => {
    if (mailboxId === this.props.mailboxId && serviceType === this.props.serviceType) {
      return this.refs[BROWSER_REF].getURL()
    } else {
      return null
    }
  }

  /**
  * Handles a navigate back call being made
  */
  handleNavigateBack = () => {
    if (this.state.isActive) {
      this.refs[BROWSER_REF].goBack()
    }
  }

  /**
  * Handles a navigate forward call being made
  */
  handleNavigateForward = () => {
    if (this.state.isActive) {
      this.refs[BROWSER_REF].goForward()
    }
  }

  /* **************************************************************************/
  // Browser Events
  /* **************************************************************************/

  /**
  * Calls multiple handlers for browser events
  * @param callers: a list of callers to execute
  * @param args: the arguments to supply them with
  */
  multiCallBrowserEvent (callers, args) {
    callers.forEach((caller) => {
      if (caller) {
        caller.apply(this, args)
      }
    })
  }

  /* **************************************************************************/
  // Browser Events : Dispatcher
  /* **************************************************************************/

  /**
  * Dispatches browser IPC messages to the correct call
  * @param evt: the event that fired
  */
  dispatchBrowserIPCMessage = (evt) => {
    switch (evt.channel.type) {
      case WB_BROWSER_NOTIFICATION_PRESENT:
        if (this.props.plugHTML5Notifications) {
          NotificationService.processHTML5MailboxNotification(
            this.props.mailboxId,
            this.props.serviceType,
            evt.channel.notificationId,
            evt.channel.notification,
            (notificationId) => {
              this.refs[BROWSER_REF].send(WB_BROWSER_NOTIFICATION_CLICK, { notificationId: notificationId })
            }
          )
        }
        break
      case WB_BROWSER_CONFIRM_PRESENT:
      case WB_BROWSER_ALERT_PRESENT:
        mailboxActions.changeActive(this.props.mailboxId, this.props.serviceType)
        break
    }
  }

  /* **************************************************************************/
  // Browser Events
  /* **************************************************************************/

  /**
  * Handles the Browser DOM becoming ready
  */
  handleBrowserDomReady = () => {
    const { service, isActive } = this.state

    // Push the custom user content
    if (service.hasCustomCSS || service.hasCustomJS) {
      this.refs[BROWSER_REF].send(WB_BROWSER_INJECT_CUSTOM_CONTENT, {
        css: service.customCSS,
        js: service.customJS
      })
    }

    // Wake or sleep the browser
    if (isActive) {
      this.refs[BROWSER_REF].send(WB_MAILBOXES_WINDOW_WEBVIEW_LIFECYCLE_AWAKEN, {})
    } else {
      this.refs[BROWSER_REF].send(WB_MAILBOXES_WINDOW_WEBVIEW_LIFECYCLE_SLEEP, {})
    }

    this.setState({
      initialLoadDone: true,
      isCrashed: false // Catch-all in case loadCommit fails
    })
  }

  /**
  * Updates the store with the current page title
  * @param evt: the event that fired
  */
  handleBrowserPageTitleUpdated = (evt) => {
    guestActions.setPageTitle([this.props.mailboxId, this.props.serviceType], evt.title)
  }

  /**
  * Updates the target url that the user is hovering over
  * @param evt: the event that fired
  */
  handleBrowserUpdateTargetUrl = (evt) => {
    this.setState({ focusedUrl: evt.url !== '' ? evt.url : null })
  }

  /**
  * Handles a load starting
  * @param evt: the event that fired
  */
  handleBrowserLoadCommit = (evt) => {
    if (evt.isMainFrame) {
      this.setState({ isCrashed: false })
    }
  }

  /**
  * Handles a load starting
  * @param evt: the event that fired
  */
  handleDidStartLoading = (evt) => {
    this.setState({ isLoading: true })
  }

  /**
  * Handles a load stopping
  * @param evt: the event that fired
  */
  handleDidStopLoading = (evt) => {
    this.setState({
      isLoading: false,
      initialLoadDone: true
    })
  }

  /**
  * Handles the browser navigating
  * @param evt: the event that fired
  */
  handleBrowserDidNavigate = (evt) => {
    if (evt.url && evt.url !== 'about:blank') {
      const { mailboxId, serviceType } = this.props
      mailboxActions.reduceService(mailboxId, serviceType, ServiceReducer.setLastUrl, evt.url)
    }
  }

  /**
  * Handles the browser navigating in page
  * @param evt: the event that fired
  */
  handleBrowserDidNavigateInPage = (evt) => {
    if (evt.isMainFrame && evt.url && evt.url !== 'about:blank') {
      const { mailboxId, serviceType } = this.props
      mailboxActions.reduceService(mailboxId, serviceType, ServiceReducer.setLastUrl, evt.url)
    }
  }

  /**
  * Handles the webcontents being attached
  * @param webContents: the webcontents that were attached
  */
  handleWebContentsAttached = (webContents) => {
    const { mailboxId, serviceType } = this.props
    ipcRenderer.send(WB_MAILBOXES_WINDOW_MAILBOX_WEBVIEW_ATTACHED, {
      webContentsId: webContents.id,
      mailboxId: mailboxId,
      serviceType: serviceType
    })

    // Update the store
    mailboxActions.setWebcontentTabId.defer(mailboxId, serviceType, webContents.id)
  }

  /**
  * Handles the webview crashing
  * @param evt: the event that fired
  */
  handleCrashed = (evt) => {
    console.log(`WebView Crashed ${this.props.mailboxId}:${this.props.serviceType}`, evt)
    this.setState({ isCrashed: true })
  }

  /* **************************************************************************/
  // Browser Events : Navigation
  /* **************************************************************************/

  /**
  * Handles a browser preparing to navigate
  * @param evt: the event that fired
  */
  handleBrowserWillNavigate = (evt) => {
    // the lamest protection again dragging files into the window
    // but this is the only thing I could find that leaves file drag working
    if (evt.url.indexOf('file://') === 0) {
      this.setState((prevState) => {
        return {
          url: URI(prevState.url).addSearch('__v__', new Date().getTime()).toString()
        }
      })
    }
  }

  /* **************************************************************************/
  // Browser Events : Focus
  /* **************************************************************************/

  /**
  * Handles a browser focusing
  */
  handleBrowserFocused () {
    mailboxDispatch.focused(this.props.mailboxId, this.props.serviceType)
  }

  /**
  * Handles a browser un-focusing
  */
  handleBrowserBlurred () {
    mailboxDispatch.blurred(this.props.mailboxId, this.props.serviceType)
  }

  /* **************************************************************************/
  // Rendering
  /* **************************************************************************/

  shouldComponentUpdate (nextProps, nextState) {
    return shallowCompare(this, nextProps, nextState)
  }

  componentDidUpdate (prevProps, prevState) {
    if (prevState.isActive !== this.state.isActive) {
      if (this.state.isActive) {
        if (this.refs[BROWSER_REF]) {
          this.refs[BROWSER_REF].focus()
          this.refs[BROWSER_REF].send(WB_MAILBOXES_WINDOW_WEBVIEW_LIFECYCLE_AWAKEN, {})
        }
      } else {
        if (this.refs[BROWSER_REF]) {
          this.refs[BROWSER_REF].send(WB_MAILBOXES_WINDOW_WEBVIEW_LIFECYCLE_SLEEP, {})
        }
      }
    }
  }

  render () {
    // Extract our props and pass props
    const {
      mailbox,
      service,
      isActive,
      focusedUrl,
      isSearching,
      searchTerm,
      searchId,
      restorableUrl,
      initialLoadDone,
      isCrashed,
      isLoading,
      snapshot,
      isolateMailboxProcesses
    } = this.state

    if (!mailbox || !service) { return false }
    const {
      className,
      preload,
      hasSearch,
      allowpopups,
      webpreferences,
      mailboxId,
      serviceType,
      ...passProps
    } = this.props
    const webviewEventProps = BrowserView.REACT_WEBVIEW_EVENTS.reduce((acc, name) => {
      acc[name] = this.props[name]
      delete passProps[name]
      return acc
    }, {})

    // Prep Clasnames and other props
    const saltedClassName = [
      className,
      'ReactComponent-MailboxWebView',
      isActive ? 'active' : undefined
    ].filter((c) => !!c).join(' ')

    // Don't use string templating or inline in jsx. The compiler optimizes it out!!
    const passWebpreferences = webpreferences || [
      'contextIsolation=yes',
      'nativeWindowOpen=yes',
      'sharedSiteInstances=yes',
      'affinity=' + (isolateMailboxProcesses ? mailboxId + ':' + serviceType : mailboxId)
    ].filter((l) => !!l).join(', ')

    return (
      <div className={saltedClassName}>
        <div className={'ReactComponent-BrowserContainer'}>
          <BrowserView
            ref={BROWSER_REF}
            id={`guest_${mailbox.id}_${service.type}`}
            preload={preload}
            partition={'persist:' + mailbox.partition}
            src={restorableUrl || 'about:blank'}
            zoomFactor={service.zoomFactor}
            searchId={searchId}
            searchTerm={isSearching ? searchTerm : ''}
            webpreferences={passWebpreferences}
            allowpopups={allowpopups === undefined ? true : allowpopups}
            plugins
            onWebContentsAttached={this.handleWebContentsAttached}

            {...webviewEventProps}

            crashed={(evt) => {
              this.multiCallBrowserEvent([this.handleCrashed, webviewEventProps.crashed], [evt])
            }}
            pageTitleUpdated={(evt) => {
              this.multiCallBrowserEvent([this.handleBrowserPageTitleUpdated, webviewEventProps.pageTitleUpdated], [evt])
            }}
            domReady={(evt) => {
              this.multiCallBrowserEvent([this.handleBrowserDomReady, webviewEventProps.domReady], [evt])
            }}
            ipcMessage={(evt) => {
              this.multiCallBrowserEvent([this.dispatchBrowserIPCMessage, webviewEventProps.ipcMessage], [evt])
            }}
            willNavigate={(evt) => {
              this.multiCallBrowserEvent([this.handleBrowserWillNavigate, webviewEventProps.willNavigate], [evt])
            }}
            focus={(evt) => {
              this.multiCallBrowserEvent([this.handleBrowserFocused, webviewEventProps.focus], [evt])
            }}
            blur={(evt) => {
              this.multiCallBrowserEvent([this.handleBrowserBlurred, webviewEventProps.blur], [evt])
            }}
            updateTargetUrl={(evt) => {
              this.multiCallBrowserEvent([this.handleBrowserUpdateTargetUrl, webviewEventProps.updateTargetUrl], [evt])
            }}
            didNavigate={(evt) => {
              this.multiCallBrowserEvent([this.handleBrowserDidNavigate, webviewEventProps.didNavigate], [evt])
            }}
            didNavigateInPage={(evt) => {
              this.multiCallBrowserEvent([this.handleBrowserDidNavigateInPage, webviewEventProps.didNavigateInPage], [evt])
            }}
            loadCommit={(evt) => {
              this.multiCallBrowserEvent([this.handleBrowserLoadCommit, webviewEventProps.loadCommit], [evt])
            }}
            didStartLoading={(evt) => {
              this.multiCallBrowserEvent([this.handleDidStartLoading, webviewEventProps.didStartLoading], [evt])
            }}
            didStopLoading={(evt) => {
              this.multiCallBrowserEvent([this.handleDidStopLoading, webviewEventProps.handleDidStopLoading], [evt])
            }}
          />
        </div>
        {initialLoadDone || !snapshot ? undefined : (
          <div className='ReactComponent-MailboxSnapshot' style={{ backgroundImage: `url("${snapshot}")` }} />
        )}
        {!service.hasNavigationToolbar && !initialLoadDone ? (
          <div className='ReactComponent-MailboxLoader'>
            <Spinner size={50} color={Colors.lightBlue600} speed={0.75} />
          </div>
        ) : undefined}
        <MailboxLoadBar isLoading={isLoading} />
        <MailboxTargetUrl url={focusedUrl} />
        {hasSearch ? (
          <MailboxSearch mailboxId={mailbox.id} serviceType={service.type} />
        ) : undefined}
        {isCrashed ? (
          <div className='ReactComponent-MailboxCrashed'>
            <h1>Whoops!</h1>
            <p>Something went wrong with this mailbox and it crashed</p>
            <br />
            <RaisedButton
              label='Reload'
              icon={<FontIcon className='material-icons'>refresh</FontIcon>}
              onClick={() => {
                this.setState({ isCrashed: false }) // Set immediately to update user
                this.reloadIgnoringCache()
              }} />
          </div>
        ) : undefined}
        {mailbox.isAuthenticationInvalid || !mailbox.hasAuth ? (
          <div className='ReactComponent-MailboxAuthInvalid'>
            <FontIcon className='material-icons primary-icon'>error_outline</FontIcon>
            <h1>Whoops!</h1>
            <p>There's an authentication problem with this account.</p>
            {mailbox.isAuthenticationInvalid ? (
              <p>The authentication information Wavebox has for this account is no longer valid.</p>
            ) : undefined}
            {!mailbox.hasAuth ? (
              <p>Wavebox doesn't have any authentication information for this account.</p>
            ) : undefined}
            <br />
            <RaisedButton
              label='Reauthenticate'
              icon={<FontIcon className='material-icons'>error_outline</FontIcon>}
              onClick={() => {
                mailboxActions.reauthenticateMailbox(mailbox.id)
              }} />
          </div>
        ) : undefined}
      </div>
    )
  }
}
