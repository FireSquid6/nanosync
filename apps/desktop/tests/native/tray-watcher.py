"""Disposable StatusNotifierWatcher, on the runner's activation-free private bus only."""
import asyncio
import json
import os
import sys
from dbus_next.aio import MessageBus
from dbus_next.service import ServiceInterface, method, dbus_property, signal
from dbus_next.constants import PropertyAccess
from dbus_next import Variant

assert os.environ['NANOSYNC_LIFECYCLE_FIXTURE'].startswith('/tmp/nanosync-native-lifecycle-')
items = []
host_registered = True


class Watcher(ServiceInterface):
    def __init__(self):
        super().__init__('org.kde.StatusNotifierWatcher')

    @method()
    def RegisterStatusNotifierItem(self, service: 's'):
        self.StatusNotifierItemRegistered(service)

    @dbus_property(access=PropertyAccess.READ)
    def RegisteredStatusNotifierItems(self) -> 'as':
        return [item[0] + item[1] for item in items]

    @dbus_property(access=PropertyAccess.READ)
    def IsStatusNotifierHostRegistered(self) -> 'b':
        return host_registered

    @dbus_property(access=PropertyAccess.READ)
    def ProtocolVersion(self) -> 'i':
        return 0

    @signal()
    def StatusNotifierItemRegistered(self, service: 's') -> 's':
        return service


async def main():
    global host_registered
    bus = await MessageBus().connect()
    watcher = Watcher()

    def observe(message):
        if message.interface == 'org.kde.StatusNotifierWatcher' and message.member == 'RegisterStatusNotifierItem':
            service = message.body[0]
            items.append((message.sender if service.startswith('/') else service,
                          service if service.startswith('/') else '/StatusNotifierItem'))
        return False

    bus.add_message_handler(observe)
    bus.export('/StatusNotifierWatcher', watcher)
    await bus.request_name('org.kde.StatusNotifierWatcher')
    print(json.dumps({'ready': True}), flush=True)
    reader = asyncio.StreamReader()
    await asyncio.get_running_loop().connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    while raw := await reader.readline():
        operation = json.loads(raw)['operation']
        if operation == 'inspect':
            if not items:
                print(json.dumps({'registered': False}), flush=True)
                continue
            service, path = items[-1]
            intro = await bus.introspect(service, path)
            proxy = bus.get_proxy_object(service, path, intro)
            properties = await proxy.get_interface('org.freedesktop.DBus.Properties').call_get_all('org.kde.StatusNotifierItem')
            menu_path = properties['Menu'].value
            menu_intro = await bus.introspect(service, menu_path)
            menu = bus.get_proxy_object(service, menu_path, menu_intro).get_interface('com.canonical.dbusmenu')
            _, layout = await menu.call_get_layout(0, -1, [])
            children = layout[2]
            labels = [child.value[1].get('label', Variant('s', '')).value for child in children]
            print(json.dumps({'registered': True, 'title': properties['Title'].value,
                              'icon': properties['IconName'].value, 'labels': labels}), flush=True)
        elif operation in ('host-off', 'host-on'):
            host_registered = operation == 'host-on'
            watcher.emit_properties_changed({'IsStatusNotifierHostRegistered': host_registered})
            print(json.dumps({'host': host_registered}), flush=True)
        elif operation == 'open':
            service, path = items[-1]
            intro = await bus.introspect(service, path)
            proxy = bus.get_proxy_object(service, path, intro)
            properties = await proxy.get_interface('org.freedesktop.DBus.Properties').call_get_all('org.kde.StatusNotifierItem')
            menu_path = properties['Menu'].value
            intro = await bus.introspect(service, menu_path)
            menu = bus.get_proxy_object(service, menu_path, intro).get_interface('com.canonical.dbusmenu')
            _, layout = await menu.call_get_layout(0, -1, [])
            child = layout[2][0].value
            await menu.call_event(child[0], 'clicked', Variant('s', ''), 0)
            print(json.dumps({'opened': True}), flush=True)
        else:
            raise RuntimeError('unknown fixture operation')


asyncio.run(main())
