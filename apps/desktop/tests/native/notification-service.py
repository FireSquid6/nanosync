import asyncio
import json
import sys
from dbus_next.aio import MessageBus
from dbus_next.service import ServiceInterface, method, signal


class Notifications(ServiceInterface):
    def __init__(self):
        super().__init__('org.freedesktop.Notifications')
        self.next_id = 40
        self.actions = True

    @method()
    def GetCapabilities(self) -> 'as':
        return ['body', 'body-markup'] + (['actions'] if self.actions else [])

    @method()
    def GetServerInformation(self) -> 'ssss':
        return ['Private fixture', 'Nanosync test', '1.0', '1.2']

    @method()
    def Notify(self, app: 's', replaces: 'u', icon: 's', summary: 's', body: 's', actions: 'as', hints: 'a{sv}', timeout: 'i') -> 'u':
        self.next_id += 1
        print(json.dumps({'event': 'notify', 'id': self.next_id, 'app': app, 'summary': summary,
                          'body': body, 'actions': actions, 'timeout': timeout}), flush=True)
        return self.next_id

    @method()
    def CloseNotification(self, ident: 'u'):
        print(json.dumps({'event': 'remote-close', 'id': ident}), flush=True)
        self.NotificationClosed(ident, 3)

    @signal()
    def ActionInvoked(self, ident: 'u', action: 's') -> 'us':
        return [ident, action]

    @signal()
    def NotificationClosed(self, ident: 'u', reason: 'u') -> 'uu':
        return [ident, reason]


async def main():
    bus = await MessageBus().connect()
    notifications = Notifications()
    bus.export('/org/freedesktop/Notifications', notifications)
    await bus.request_name('org.freedesktop.Notifications')
    print(json.dumps({'event': 'ready'}), flush=True)
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin)
    while line := await reader.readline():
        command = json.loads(line)
        if command['operation'] == 'open':
            notifications.ActionInvoked(command['id'], 'open')
        elif command['operation'] == 'close':
            notifications.NotificationClosed(command['id'], command['reason'])
        elif command['operation'] == 'reuse':
            notifications.ActionInvoked(command['id'], 'open')
            notifications.NotificationClosed(command['id'], 2)
        elif command['operation'] == 'no-actions':
            notifications.actions = False
        elif command['operation'] == 'stop':
            break
        print(json.dumps({'event': 'barrier'}), flush=True)
    bus.disconnect()


asyncio.run(main())
