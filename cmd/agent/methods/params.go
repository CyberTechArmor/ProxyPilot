package methods

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

func decodeParams(raw json.RawMessage, target any) error {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		raw = []byte("{}")
	}
	if raw[0] != '{' {
		return fmt.Errorf("params must be an object")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return fmt.Errorf("params do not match the method schema")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return fmt.Errorf("one params object is required")
	}
	return nil
}

func noParams(handler Handler) Handler {
	return func(params json.RawMessage) (any, *Error) {
		if err := decodeParams(params, &struct{}{}); err != nil {
			return nil, &Error{Code: "invalid_params", Message: err.Error()}
		}
		return handler(params)
	}
}
