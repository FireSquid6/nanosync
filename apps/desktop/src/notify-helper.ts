// libnotify owns the protocol; one bounded helper keeps callbacks off SDK threads.
export const notifyHelper = String.raw`
import gi, json, os

gi.require_version('Notify', '0.7')
from gi.repository import Notify, GLib, Gio
Notify.init('Nanosync')
loop = GLib.MainLoop()
active = {}
buffer = b''
owner = None
epoch = 0
name = 'org.freedesktop.Notifications'
path = '/org/freedesktop/Notifications'
connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)

def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)

def invalidate(next_owner):
    global owner, epoch
    if owner == next_owner:
        return
    owner = next_owner
    epoch += 1
    for record in active.values():
        notification = record['notification']
        notification.disconnect(record['closed'])
        notification.clear_actions()
        notification.props.id = 0
    active.clear()
    emit({'event': 'owner', 'epoch': epoch})

def current_owner():
    try:
        result = connection.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'GetNameOwner', GLib.Variant('(s)', (name,)),
            GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 4000, None)
        current = result.unpack()[0]
    except GLib.Error:
        current = None
    invalidate(current)
    return current

def close_record(record):
    # Unique-owner destination: an old numeric ID must never target a restarted service.
    try:
        connection.call_sync(record['owner'], path, name, 'CloseNotification',
            GLib.Variant('(u)', (record['id'],)), None, Gio.DBusCallFlags.NONE, 4000, None)
    except GLib.Error:
        record['notification'].props.id = 0

def closed(notification, category, record):
    current_owner()
    if record['epoch'] != epoch:
        return
    reason = notification.get_closed_reason()
    emit({'event': 'closed', 'category': category, 'epoch': epoch,
          'id': record['id'], 'reason': reason if reason in (1,2,3,4) else 4})
    if active.get(category) is record:
        del active[category]

def action(notification, action_id, data):
    category, record = data
    current_owner()
    if action_id == 'open' and record['epoch'] == epoch:
        emit({'event': 'open', 'category': category, 'epoch': epoch, 'id': record['id']})

def dispatch(command):
    sequence = command['sequence']
    operation = command['operation']
    current = current_owner()
    if operation == 'probe':
        if not current or not Notify.get_server_info()[0]:
            raise ValueError()
        caps = Notify.get_server_caps()
        emit({'sequence': sequence, 'available': True, 'actions': 'actions' in caps, 'epoch': epoch})
    elif operation == 'submit':
        category = command['category']
        if category not in ('conflicts','revokedAccess','persistentFailures') or not current:
            raise ValueError()
        body = command['body']
        if not isinstance(body, str) or len(body.encode()) > 8192:
            raise ValueError()
        previous = active.pop(category, None)
        if previous:
            close_record(previous)
            previous['notification'].disconnect(previous['closed'])
            previous['notification'].clear_actions()
        notification = Notify.Notification.new('Nanosync — Needs attention', body, 'dialog-warning')
        notification.set_timeout(10000)
        record = {'notification': notification, 'id': 0, 'owner': current, 'epoch': epoch}
        record['closed'] = notification.connect('closed', closed, category, record)
        caps = Notify.get_server_caps()
        if 'actions' in caps:
            notification.add_action('open', 'Open Nanosync', action, (category, record))
        active[category] = record
        if not notification.show():
            raise ValueError()
        ident = notification.props.id
        current_owner()
        if record['epoch'] != epoch or ident <= 0:
            raise ValueError()
        record['id'] = ident
        emit({'sequence': sequence, 'id': ident, 'available': True,
              'actions': 'actions' in caps, 'epoch': epoch})
    elif operation == 'stop':
        for record in list(active.values()):
            close_record(record)
        active.clear()
        emit({'sequence': sequence, 'stopped': True})
        loop.quit()
    else:
        raise ValueError()

def input_ready(source, condition):
    global buffer
    if condition & (GLib.IO_HUP | GLib.IO_ERR):
        loop.quit()
        return False
    data = os.read(0, 8192)
    if not data:
        loop.quit()
        return False
    buffer += data
    if len(buffer) > 16384:
        loop.quit()
        return False
    while b'\n' in buffer:
        line, buffer = buffer.split(b'\n', 1)
        command = None
        try:
            command = json.loads(line)
            dispatch(command)
        except Exception:
            sequence = command.get('sequence', 0) if isinstance(command, dict) else 0
            emit({'sequence': sequence, 'available': False, 'actions': False, 'epoch': epoch})
    return True

proxy = Gio.DBusProxy.new_sync(connection,
    Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES | Gio.DBusProxyFlags.DO_NOT_AUTO_START,
    None, name, path, name, None)
proxy.connect('notify::g-name-owner', lambda *_: current_owner())
current_owner()
GLib.io_add_watch(0, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, input_ready)
loop.run()
Notify.uninit()
`;
