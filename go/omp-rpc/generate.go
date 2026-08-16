package omprpc

// Generated bindings are checked in. This directive maps the canonical repository schema
// to the v17 module package without duplicating or modifying that schema.
//go:generate protoc -I ../../packages/grpc --go_out=. --go_opt=module=github.com/can1357/oh-my-pi/go/omp-rpc/v17 --go_opt=Mproto/omp_rpc.proto=github.com/can1357/oh-my-pi/go/omp-rpc/v17/internal/gen;omprpcv1 --go-grpc_out=. --go-grpc_opt=module=github.com/can1357/oh-my-pi/go/omp-rpc/v17 --go-grpc_opt=Mproto/omp_rpc.proto=github.com/can1357/oh-my-pi/go/omp-rpc/v17/internal/gen;omprpcv1 ../../packages/grpc/proto/omp_rpc.proto
