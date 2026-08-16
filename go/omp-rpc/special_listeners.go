package omprpc

import "sync"

// OnReady registers a listener for the negotiated Ready frame.
func (c *Client) OnReady(listener func(ReadyEvent)) func() {
	return c.OnNotification(func(notification Notification) {
		if ready, ok := notification.(ReadyEvent); ok {
			listener(ready)
		}
	})
}

// OnUIRequest registers a typed extension UI listener.
func (c *Client) OnUIRequest(listener func(*ExtensionUIRequest)) func() {
	return c.OnNotification(func(notification Notification) {
		if request, ok := notification.(*ExtensionUIRequest); ok {
			listener(request)
		}
	})
}

// OnExtensionError registers a typed extension error listener.
func (c *Client) OnExtensionError(listener func(*ExtensionError)) func() {
	return c.OnNotification(func(notification Notification) {
		if event, ok := notification.(*ExtensionError); ok {
			listener(event)
		}
	})
}

// OnUnknownNotification registers a listener for unknown or malformed pushes.
func (c *Client) OnUnknownNotification(listener func(UnknownNotification)) func() {
	return c.OnNotification(func(notification Notification) {
		if event, ok := notification.(UnknownNotification); ok {
			listener(event)
		}
	})
}

// OnProtocolError registers a listener for protocol errors.
func (c *Client) OnProtocolError(listener func(*ProtocolError)) func() {
	c.mu.Lock()
	c.nextListener++
	id := c.nextListener
	c.protocolListeners[id] = listener
	c.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { c.mu.Lock(); delete(c.protocolListeners, id); c.mu.Unlock() }) }
}

// OnListenerError registers a listener for isolated listener panics. Panics in this listener are swallowed.
func (c *Client) OnListenerError(listener func(ListenerError)) func() {
	c.mu.Lock()
	c.nextListener++
	id := c.nextListener
	c.listenerErrorListeners[id] = listener
	c.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { c.mu.Lock(); delete(c.listenerErrorListeners, id); c.mu.Unlock() }) }
}
