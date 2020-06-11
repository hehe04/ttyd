import { bind } from 'decko';
import * as backoff from 'backoff';
import { Component, h } from 'preact';
import { ITerminalOptions, Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebglAddon } from 'xterm-addon-webgl';
import { WebLinksAddon } from 'xterm-addon-web-links';

import { OverlayAddon } from './overlay';
import { ZmodemAddon } from '../zmodem';

import 'xterm/css/xterm.css';
import { ninvoke } from 'q';

interface TtydTerminal extends Terminal {
    fit(): void;
}

declare global {
    interface Window {
        term: TtydTerminal;
    }
}

const enum Command {
    // server side
    OUTPUT = '0',
    SET_WINDOW_TITLE = '1',
    SET_PREFERENCES = '2',

    // client side
    INPUT = '0',
    RESIZE_TERMINAL = '1',
}

interface Props {
    id: string;
    wsUrl: string;
    tokenUrl: string;
    options: ITerminalOptions;
}

export class Xterm extends Component<Props> {
    private textEncoder: TextEncoder;
    private textDecoder: TextDecoder;
    private container: HTMLElement;
    private terminal: Terminal;
    private fitAddon: FitAddon;
    private overlayAddon: OverlayAddon;
    private zmodemAddon: ZmodemAddon;
    private socket: WebSocket;
    private token: string;
    private title: string;
    private resizeTimeout: number;
    private backoff: backoff.Backoff;
    private backoffLock = false;
    private reconnect = false;
    private ping = null;
    private disableSZ = true;

    constructor(props: Props) {
        super(props);

        this.textEncoder = new TextEncoder();
        this.textDecoder = new TextDecoder();
        this.fitAddon = new FitAddon();
        this.overlayAddon = new OverlayAddon();
        this.backoff = backoff.exponential({
            initialDelay: 100,
            maxDelay: 10000,
        });
        this.backoff.failAfter(15);
        this.backoff.on('ready', () => {
            this.backoffLock = false;
            this.refreshToken().then(this.connect);
        });
        this.backoff.on('backoff', (_, delay: number) => {
            console.log(`[ttyd] will attempt to reconnect websocket in ${delay}ms`);
            this.backoffLock = true;
        });
        this.backoff.on('fail', () => {
            this.backoffLock = true; // break backoff
        });
    }

    async componentDidMount() {
        await this.refreshToken();
        this.openTerminal();
        this.connect();

        window.addEventListener('resize', this.onWindowResize);
        window.addEventListener('beforeunload', this.onWindowUnload);
        setInterval(() => { this.refreshToken() }, 60 * 1000)//to refresh cookie_pame_token
    }

    componentWillUnmount() {
        this.socket.close();
        this.terminal.dispose();

        window.removeEventListener('resize', this.onWindowResize);
        window.removeEventListener('beforeunload', this.onWindowUnload);
    }

    render({ id }: Props) {
        return (
            <div id={id} ref={c => (this.container = c)}>
                <ZmodemAddon ref={c => (this.zmodemAddon = c)} sender={this.sendData} disablesz={this.disableSZ} />
            </div>
        );
    }

    @bind
    private sendData(data: ArrayLike<number>) {
        const { socket } = this;
        const payload = new Uint8Array(data.length + 1);
        payload[0] = Command.INPUT.charCodeAt(0);
        payload.set(data, 1);
        socket.send(payload);
    }

    @bind
    private async refreshToken() {
        try {
            const resp = await fetch(this.props.tokenUrl);
            if (resp.ok) {
                const json = await resp.json();
                this.token = json.token;
            }
        } catch (e) {
            console.error(`[ttyd] fetch ${this.props.tokenUrl}: `, e);
        }
    }

    @bind
    private onWindowResize() {
        const { fitAddon } = this;
        clearTimeout(this.resizeTimeout);
        this.resizeTimeout = setTimeout(() => fitAddon.fit(), 250) as any;
    }

    @bind
    private onWindowUnload(event: BeforeUnloadEvent): any {
        const { socket } = this;
        if (socket && socket.readyState === WebSocket.OPEN) {
            const message = 'Close terminal? this will also terminate the command.';
            event.returnValue = message;
            return message;
        }
        event.preventDefault();
    }

    @bind
    private openTerminal() {
        this.terminal = new Terminal(this.props.options);
        const { terminal, container, fitAddon, overlayAddon } = this;
        window.term = terminal as TtydTerminal;
        window.term.fit = () => {
            this.fitAddon.fit();
        };

        terminal.loadAddon(fitAddon);
        terminal.loadAddon(overlayAddon);
        terminal.loadAddon(new WebLinksAddon());
        terminal.loadAddon(this.zmodemAddon);

        terminal.onTitleChange(data => {
            if (data && data !== '') {
                document.title = data + ' | ' + this.title;
            }
        });
        terminal.onData(this.onTerminalData);
        terminal.onResize(this.onTerminalResize);
        if (document.queryCommandSupported && document.queryCommandSupported('copy')) {
            terminal.onSelectionChange(() => {
                if (terminal.getSelection() === '') return;
                overlayAddon.showOverlay('\u2702', 200);
                document.execCommand('copy');
            });
        }
        terminal.open(container);
    }

    @bind
    private connect() {
        this.socket = new WebSocket(this.props.wsUrl, ['tty']);
        const { socket } = this;

        socket.binaryType = 'arraybuffer';
        socket.onopen = this.onSocketOpen;
        socket.onmessage = this.onSocketData;
        socket.onclose = this.onSocketClose;
        socket.onerror = this.onSocketError;
    }

    @bind
    private onSocketOpen() {
        console.log('[ttyd] websocket connection opened');
        this.backoff.reset();

        const { socket, textEncoder, terminal, fitAddon } = this;
        socket.send(textEncoder.encode(JSON.stringify({ AuthToken: this.token })));

        if (this.reconnect) {
            const dims = fitAddon.proposeDimensions();
            terminal.reset();
            terminal.resize(dims.cols, dims.rows);
            this.onTerminalResize(dims); // may not be triggered by terminal.resize
        } else {
            this.reconnect = true;
            fitAddon.fit();
        }

        /** 连接后启动 PING，PONG 心跳 */
        if (null === this.ping) {
            /** 1分钟心跳一次，注意这个值需要设置的比 代理的 设置的值要小，不然被关闭了就没意义了。 */
            this.ping = setInterval(() => {
                socket.send("PING");
            }, 30 * 1000)
        }
        terminal.focus();
    }

    @bind
    private onSocketClose(event: CloseEvent) {
        console.log(`[ttyd] websocket connection closed with code: ${event.code}`);

        const { backoff, backoffLock, overlayAddon } = this;
        overlayAddon.showOverlay('Connection Closed', null);

        // 1000: CLOSE_NORMAL
        if (event.code !== 1000 && !backoffLock) {
            backoff.backoff();
        }
        /** 连接被关闭后停止 PING-PONG 心跳 */
        if (null !== this.ping) {
            clearInterval(this.ping)
            this.ping = null
        }
    }

    @bind
    private onSocketError(event: Event) {
        console.error('[ttyd] websocket connection error: ', event);
        const { backoff, backoffLock } = this;
        if (!backoffLock) {
            backoff.backoff();
        }
    }

    @bind
    private onSocketData(event: MessageEvent) {
        const { terminal, textDecoder, zmodemAddon } = this;
        const rawData = event.data as ArrayBuffer;
        const cmd = String.fromCharCode(new Uint8Array(rawData)[0]);
        const data = rawData.slice(1);

        switch (cmd) {
            case Command.OUTPUT:
                zmodemAddon.consume(data);
                break;
            case Command.SET_WINDOW_TITLE:
                this.title = textDecoder.decode(data);
                document.title = this.title;
                break;
            case Command.SET_PREFERENCES:
                const preferences = JSON.parse(textDecoder.decode(data));
                Object.keys(preferences).forEach(key => {
                    if (key === 'rendererType' && preferences[key] === 'webgl') {
                        terminal.loadAddon(new WebglAddon());
                        console.log(`[ttyd] WebGL renderer enabled`);
                    } else {
                        if (key === "dissz") {
                            this.disableSZ = preferences[key];
                            this.setState({ disablesz: this.disableSZ });
                            console.log(`[ttyd] option: ${key}=${preferences[key]}`);
                        } else {
                            terminal.setOption(key, preferences[key]);
                        }
                    }
                });
                break;
            default:
                console.warn(`[ttyd] unknown command: ${cmd}`);
                break;
        }
    }

    @bind
    private onTerminalResize(size: { cols: number; rows: number }) {
        const { overlayAddon, socket, textEncoder } = this;
        if (socket.readyState === WebSocket.OPEN) {
            const msg = JSON.stringify({ columns: size.cols, rows: size.rows });
            socket.send(textEncoder.encode(Command.RESIZE_TERMINAL + msg));
        }
        setTimeout(() => {
            overlayAddon.showOverlay(`${size.cols}x${size.rows}`);
        }, 500);
    }

    @bind
    private onTerminalData(data: string) {
        const { socket, textEncoder } = this;
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(textEncoder.encode(Command.INPUT + data));
        }
    }
}
